-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "address" TEXT;

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "tax_rate" DECIMAL(6,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "due_on" DATE,
ADD COLUMN     "issued_at" TIMESTAMPTZ(3),
ADD COLUMN     "memo" TEXT,
ADD COLUMN     "subtotal_minor" BIGINT,
ADD COLUMN     "tax_minor" BIGINT,
ADD COLUMN     "total_minor" BIGINT;

-- CreateTable
CREATE TABLE "invoice_counters" (
    "organization_id" UUID NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("organization_id")
);

-- AddForeignKey
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;



-- Written by hand from here (DESIGN.md, "Invoices").

-- Bounds the application also checks (src/server/invoices/money.ts): with at most 100 lines, the largest
-- invoice (100 x 1,000,000 x 10^10, doubled by a 100% tax) is 2 x 10^18, inside bigint.
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quantity_max" CHECK ("quantity" <= 1000000);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unit_price_max" CHECK ("unit_price_minor" <= 10000000000);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_rate_range" CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);
ALTER TABLE "customers" ADD CONSTRAINT "customers_address_length" CHECK (length("address") <= 500);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_memo_length" CHECK (length("memo") <= 1000);
-- A draft has none of these; a finalized invoice has all of them, and its total adds up.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_final_fields" CHECK (
    ("status" = 'DRAFT') = ("issued_at" IS NULL) AND ("status" = 'DRAFT') = ("due_on" IS NULL)
    AND ("status" = 'DRAFT') = ("subtotal_minor" IS NULL) AND ("status" = 'DRAFT') = ("tax_minor" IS NULL)
    AND ("status" = 'DRAFT') = ("total_minor" IS NULL));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_total_adds_up" CHECK ("total_minor" = "subtotal_minor" + "tax_minor");
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_positive" CHECK ("last_number" > 0);

-- invoice_counters is tenant-owned like the other tenant tables.
ALTER TABLE "invoice_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_counters"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- An invoice's totals by the rule money.ts states: each line rounded half up to the minor unit, tax once per
-- rate on that rate's sum, rounded half up. round(numeric) rounds half away from zero, which is half up for
-- these non-negative amounts, and every operand is exact (numeric multiplication doesn't round; the rate is
-- multiplied by 0.01 rather than divided by 100, so nothing is cut to a division's result scale first).
-- SECURITY INVOKER (the default): it reads lines under the caller's row-level security.
CREATE FUNCTION "invoice_totals"(p_organization_id uuid, p_invoice_id uuid,
                                 OUT subtotal_minor bigint, OUT tax_minor bigint)
    LANGUAGE sql STABLE
    SET search_path = pg_catalog, public
AS $$
    WITH groups AS (
        SELECT tax_rate, sum(round(quantity * unit_price_minor)) AS base
        FROM invoice_lines
        WHERE organization_id = p_organization_id AND invoice_id = p_invoice_id
        GROUP BY tax_rate
    )
    SELECT coalesce(sum(base), 0)::bigint, coalesce(sum(round(base * tax_rate * 0.01)), 0)::bigint FROM groups
$$;

-- The invoice life cycle, enforced for every writer (DESIGN.md, "Life cycle"):
--   INSERT: always a draft.
--   DRAFT -> DRAFT: edits; DRAFT -> OPEN: finalization, where this trigger sets the number, issue time and
--   totals (the application has no privilege on those columns); a draft can't become PAID or VOID.
--   OPEN -> PAID or VOID; PAID and VOID are final. Once out of draft, nothing but the status changes.
--   DELETE: only drafts (a deleted numbered invoice would be a gap), except when the organization itself is
--   being deleted (its cascade has already removed the organization row).
CREATE FUNCTION "invoices_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    totals record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'DRAFT' THEN
            RAISE EXCEPTION 'tally: a new invoice must be a draft' USING ERRCODE = 'TL001';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'DRAFT' AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
            RAISE EXCEPTION 'tally: invoice % is final and can''t be deleted (void it)', OLD.number
                USING ERRCODE = 'TL002';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status = 'DRAFT' THEN
        IF NEW.status = 'DRAFT' THEN
            RETURN NEW;
        ELSIF NEW.status <> 'OPEN' THEN
            RAISE EXCEPTION 'tally: a draft can only be finalized or deleted, not marked %', NEW.status
                USING ERRCODE = 'TL003';
        END IF;
        -- Finalization. The row is already locked (BEFORE UPDATE triggers run on the locked row), and line
        -- writes lock it too (invoice_lines_guard), so the lines can't change between here and COMMIT.
        IF NOT EXISTS (SELECT 1 FROM invoice_lines WHERE organization_id = NEW.organization_id AND invoice_id = NEW.id) THEN
            RAISE EXCEPTION 'tally: an invoice needs at least one line to be finalized' USING ERRCODE = 'TL004';
        END IF;
        SELECT * INTO totals FROM invoice_totals(NEW.organization_id, NEW.id);
        NEW.subtotal_minor := totals.subtotal_minor;
        NEW.tax_minor := totals.tax_minor;
        NEW.total_minor := totals.subtotal_minor + totals.tax_minor;
        -- The next number. The upsert locks the organization's counter row until this transaction ends, so
        -- concurrent finalizations take turns; a rollback undoes the increment, so no number is skipped.
        INSERT INTO invoice_counters AS c (organization_id, last_number) VALUES (NEW.organization_id, 1)
            ON CONFLICT (organization_id) DO UPDATE SET last_number = c.last_number + 1
            RETURNING c.last_number INTO NEW.number;
        -- The issue time is taken after the number, while the counter is locked: the previous number's
        -- transaction has committed by now, so issue times never run backwards against the numbers.
        NEW.issued_at := clock_timestamp();
        IF NEW.due_on IS NULL OR NEW.due_on < (NEW.issued_at AT TIME ZONE 'UTC')::date THEN
            RAISE EXCEPTION 'tally: the due date must be on or after the issue date' USING ERRCODE = 'TL005';
        END IF;
        RETURN NEW;
    END IF;

    IF (NEW.customer_id, NEW.currency, NEW.number, NEW.memo, NEW.issued_at, NEW.due_on,
        NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor)
       IS DISTINCT FROM
       (OLD.customer_id, OLD.currency, OLD.number, OLD.memo, OLD.issued_at, OLD.due_on,
        OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor) THEN
        RAISE EXCEPTION 'tally: invoice % is final; only its status can change', OLD.number USING ERRCODE = 'TL006';
    END IF;
    IF NEW.status = OLD.status OR (OLD.status = 'OPEN' AND NEW.status IN ('PAID', 'VOID')) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tally: invoice % can''t go from % to %', OLD.number, OLD.status, NEW.status
        USING ERRCODE = 'TL007';
END
$$;

CREATE TRIGGER "invoices_guard" BEFORE INSERT OR UPDATE OR DELETE ON "invoices"
    FOR EACH ROW EXECUTE FUNCTION "invoices_guard"();

-- Lines change only while their invoice is a draft. FOR NO KEY UPDATE locks the invoice row against a
-- concurrent finalization (and against other line writes to the same invoice, which makes the line cap exact);
-- it doesn't conflict with the foreign-key checks' FOR KEY SHARE. Not finding the invoice means it is
-- invisible (another tenant's: the foreign key then refuses the insert with the same error as a missing one)
-- or gone (a draft's delete cascading to its lines).
CREATE FUNCTION "invoice_lines_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    line invoice_lines%ROWTYPE;
    invoice_status invoice_status;
BEGIN
    IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
    SELECT status INTO invoice_status FROM invoices
        WHERE organization_id = line.organization_id AND id = line.invoice_id
        FOR NO KEY UPDATE;
    IF FOUND THEN
        IF invoice_status <> 'DRAFT' THEN
            RAISE EXCEPTION 'tally: the invoice is final; its lines can''t change' USING ERRCODE = 'TL008';
        END IF;
        IF TG_OP = 'INSERT' AND (SELECT count(*) FROM invoice_lines
                                 WHERE organization_id = line.organization_id AND invoice_id = line.invoice_id) >= 100 THEN
            RAISE EXCEPTION 'tally: an invoice can have at most 100 lines' USING ERRCODE = 'TL009';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER "invoice_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
    FOR EACH ROW EXECUTE FUNCTION "invoice_lines_guard"();

-- Privileges. The application may not write an invoice's number, issue time or totals (the trigger does), nor
-- change its currency (prices are in its minor unit). It needs the counter only through the trigger, which
-- runs as the application role, so it gets exactly the upsert's privileges.
REVOKE INSERT ("number"), UPDATE ("number"), UPDATE ("currency") ON "invoices" FROM tally_app;
GRANT INSERT ("memo"), UPDATE ("customer_id", "memo", "due_on") ON "invoices" TO tally_app;
GRANT INSERT ("address"), UPDATE ("address") ON "customers" TO tally_app;
GRANT INSERT ("tax_rate"), UPDATE ("tax_rate") ON "invoice_lines" TO tally_app;
GRANT SELECT, INSERT ("organization_id", "last_number"), UPDATE ("last_number") ON "invoice_counters" TO tally_app;
