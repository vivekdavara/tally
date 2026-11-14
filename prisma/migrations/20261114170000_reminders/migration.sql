-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "stage" SMALLINT NOT NULL,
    "recipient" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "last_error" TEXT,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reminders_organization_id_id_key" ON "reminders"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_organization_id_invoice_id_stage_key" ON "reminders"("organization_id", "invoice_id", "stage");

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- Written by hand from here: overdue reminders (DESIGN.md, "Overdue reminders").

-- The stages: a reminder when an invoice is 1, 7, 14 and 30 days past due, at most one per stage, ever (the unique
-- key above). Sending gives up after 8 attempts.
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_stage" CHECK ("stage" IN (1, 7, 14, 30));
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_attempts" CHECK ("attempts" BETWEEN 0 AND 8);
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_last_error_length" CHECK (length("last_error") <= 500);

-- What the sender looks for: unsent reminders whose next attempt is due.
CREATE INDEX "reminders_unsent" ON "reminders" ("organization_id", "next_attempt_at") WHERE "sent_at" IS NULL;

ALTER TABLE "reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reminders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "reminders"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- Column by column: which invoice and stage is written once (the recipient comes from the invoice, by the trigger);
-- afterwards only the sending bookkeeping changes. Nothing is deleted: a reminder is a record of what a customer
-- was sent.
GRANT SELECT,
      INSERT ("organization_id", "invoice_id", "stage"),
      UPDATE ("attempts", "next_attempt_at", "last_error", "sent_at")
    ON "reminders" TO tally_app;

-- A reminder is queued only for an open invoice that is at least `stage` days past due by the database's clock
-- (UTC dates, as due_on is), addressed to the invoice's bill-to email; it is sent once. SQLSTATEs TL021 (a rule a
-- correct job never breaks) and TL022 (the invoice isn't due a reminder: a race with paying it).
CREATE FUNCTION "reminders_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    invoice record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.sent_at IS NOT NULL OR NEW.attempts <> 0 OR NEW.last_error IS NOT NULL THEN
            RAISE EXCEPTION 'tally: a new reminder starts unsent' USING ERRCODE = 'TL021';
        END IF;
        -- FOR SHARE: paying or voiding the invoice (an UPDATE of its row) waits for this transaction, and this
        -- insert for theirs, so a reminder is never queued for an invoice that a committed payment closed.
        SELECT status, due_on, bill_to_email INTO invoice FROM invoices
            WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id
            FOR SHARE;
        IF NOT FOUND OR invoice.status <> 'OPEN'
           OR invoice.due_on + NEW.stage > (clock_timestamp() AT TIME ZONE 'UTC')::date THEN
            RAISE EXCEPTION 'tally: this invoice isn''t due that reminder' USING ERRCODE = 'TL022';
        END IF;
        NEW.recipient := invoice.bill_to_email;
        NEW.created_at := clock_timestamp();
        NEW.next_attempt_at := NEW.created_at;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
            RAISE EXCEPTION 'tally: reminders are kept' USING ERRCODE = 'TL021';
        END IF;
        RETURN OLD;
    END IF;
    IF (NEW.id, NEW.organization_id, NEW.invoice_id, NEW.stage, NEW.recipient, NEW.created_at)
       IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.invoice_id, OLD.stage, OLD.recipient, OLD.created_at) THEN
        RAISE EXCEPTION 'tally: only a reminder''s sending can change' USING ERRCODE = 'TL021';
    END IF;
    IF OLD.sent_at IS NOT NULL THEN
        RAISE EXCEPTION 'tally: this reminder was already sent' USING ERRCODE = 'TL021';
    END IF;
    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'tally: attempts only go up' USING ERRCODE = 'TL021';
    END IF;
    IF NEW.sent_at IS NOT NULL THEN
        NEW.sent_at := clock_timestamp();
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER "reminders_guard" BEFORE INSERT OR UPDATE OR DELETE ON "reminders"
    FOR EACH ROW EXECUTE FUNCTION "reminders_guard"();
