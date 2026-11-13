-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "checkout_session_id" TEXT NOT NULL,
    "checkout_url" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "payment_intent_id" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "refund_due" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payment_id" UUID,
    "outcome" TEXT,
    "stripe_created_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_organization_id_invoice_id_idx" ON "payments"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_id_key" ON "payments"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_organization_id_checkout_session_id_key" ON "payments"("organization_id", "checkout_session_id");

-- CreateIndex
CREATE INDEX "stripe_events_organization_id_payment_id_idx" ON "stripe_events"("organization_id", "payment_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_organization_id_payment_id_fkey" FOREIGN KEY ("organization_id", "payment_id") REFERENCES "payments"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- Written by hand from here: billing (DESIGN.md, "Billing").

-- Shapes the application relies on. Provider ids are what Stripe documents (prefix, then letters, digits and
-- underscores); the mock provider's ids have the same shape.
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider" CHECK ("provider" IN ('mock', 'stripe'));
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_session_id_format" CHECK ("checkout_session_id" ~ '^cs_[A-Za-z0-9_]{1,250}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_intent_id_format" CHECK ("payment_intent_id" ~ '^pi_[A-Za-z0-9_]{1,250}$');
ALTER TABLE "payments" ADD CONSTRAINT "payments_url_format" CHECK ("checkout_url" ~ '^(https://|/)' AND length("checkout_url") <= 2048);
-- paid_at says when money arrived, so it is set exactly on successful payments.
ALTER TABLE "payments" ADD CONSTRAINT "payments_paid_at_when_succeeded" CHECK (("status" = 'SUCCEEDED') = ("paid_at" IS NOT NULL));
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_id_format" CHECK ("id" ~ '^evt_[A-Za-z0-9_]{1,250}$');
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_type_format" CHECK ("type" ~ '^[a-z_.]{1,100}$');
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_outcome_format" CHECK ("outcome" ~ '^[a-z-]{1,40}$');

-- At most one live attempt per invoice: a second "collect payment" reuses the first session instead of
-- giving the customer two links that could both be paid.
CREATE UNIQUE INDEX "payments_one_live_per_invoice" ON "payments" ("organization_id", "invoice_id")
    WHERE "status" IN ('PENDING', 'PROCESSING');

-- Row-level security, as on every tenant table (migrations/*_row_level_security). Webhook processing runs in
-- a withTenant transaction for the organization the signed event names, so it sees only that tenant's rows.
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payments"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE "stripe_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stripe_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "stripe_events"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- Column by column, as in *_least_privilege. A payment's amount, currency, invoice and session are written once,
-- at creation; afterwards only its outcome changes. Nothing is deleted: a payment record is evidence that money
-- was asked for or moved. An event row is written once, its outcome filled in by the same transaction.
-- INSERT covers status and refund_due only because Prisma writes static @default values into its INSERTs; the
-- trigger accepts nothing but PENDING and false there.
GRANT SELECT,
      INSERT ("organization_id", "invoice_id", "provider", "checkout_session_id", "checkout_url", "amount_minor", "currency", "expires_at",
              "status", "refund_due"),
      UPDATE ("status", "payment_intent_id", "paid_at", "refund_due")
    ON "payments" TO tally_app;
GRANT SELECT,
      INSERT ("id", "organization_id", "type", "payment_id", "stripe_created_at"),
      UPDATE ("outcome")
    ON "stripe_events" TO tally_app;

-- The payment life cycle, for every writer (like invoices_guard). SQLSTATEs TL011-TL015.
CREATE FUNCTION "payments_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    invoice record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'PENDING' OR NEW.payment_intent_id IS NOT NULL OR NEW.paid_at IS NOT NULL OR NEW.refund_due THEN
            RAISE EXCEPTION 'tally: a new payment starts pending' USING ERRCODE = 'TL011';
        END IF;
        -- FOR SHARE conflicts with the row lock of the UPDATE that pays or voids the invoice, so the two take
        -- turns: a payment is only created for an invoice that is open, for exactly what it totals.
        SELECT status, currency, total_minor INTO invoice FROM invoices
            WHERE organization_id = NEW.organization_id AND id = NEW.invoice_id
            FOR SHARE;
        IF NOT FOUND OR invoice.status <> 'OPEN' THEN
            RAISE EXCEPTION 'tally: only an open invoice can be paid' USING ERRCODE = 'TL012';
        END IF;
        IF NEW.amount_minor <> invoice.total_minor OR NEW.currency <> invoice.currency THEN
            RAISE EXCEPTION 'tally: a payment must be for the invoice''s total, in its currency' USING ERRCODE = 'TL013';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        -- Only the organization's own deletion removes payments (as in invoices_guard).
        IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
            RAISE EXCEPTION 'tally: payment records are kept' USING ERRCODE = 'TL014';
        END IF;
        RETURN OLD;
    END IF;

    IF (NEW.id, NEW.organization_id, NEW.invoice_id, NEW.provider, NEW.checkout_session_id, NEW.checkout_url,
        NEW.amount_minor, NEW.currency, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.invoice_id, OLD.provider, OLD.checkout_session_id, OLD.checkout_url,
        OLD.amount_minor, OLD.currency, OLD.expires_at, OLD.created_at) THEN
        RAISE EXCEPTION 'tally: only a payment''s outcome can change' USING ERRCODE = 'TL014';
    END IF;
    IF (OLD.refund_due AND NOT NEW.refund_due)
       OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id)
       OR (OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at) THEN
        RAISE EXCEPTION 'tally: a recorded payment outcome can''t be undone' USING ERRCODE = 'TL014';
    END IF;
    IF NEW.status = OLD.status
       OR (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED'))
       OR (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED', 'FAILED'))
       -- Money that arrives after an attempt was given up on is still recorded.
       OR (OLD.status IN ('FAILED', 'EXPIRED') AND NEW.status = 'SUCCEEDED') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tally: a payment can''t go from % to %', OLD.status, NEW.status USING ERRCODE = 'TL015';
END
$$;

CREATE TRIGGER "payments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payments"
    FOR EACH ROW EXECUTE FUNCTION "payments_guard"();

-- An event row is written once; its outcome is filled in once, by the transaction that processed it.
CREATE FUNCTION "stripe_events_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
            RAISE EXCEPTION 'tally: processed events are kept' USING ERRCODE = 'TL016';
        END IF;
        RETURN OLD;
    END IF;
    IF (NEW.id, NEW.organization_id, NEW.type, NEW.payment_id, NEW.stripe_created_at, NEW.received_at)
       IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.type, OLD.payment_id, OLD.stripe_created_at, OLD.received_at)
       OR OLD.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'tally: an event''s outcome is written once' USING ERRCODE = 'TL016';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER "stripe_events_guard" BEFORE UPDATE OR DELETE ON "stripe_events"
    FOR EACH ROW EXECUTE FUNCTION "stripe_events_guard"();
