-- A finalized invoice keeps who it was issued to. Before this, its page and PDF showed the customer's current
-- name, email and address, so editing a customer rewrote every invoice already sent to them (review of day 2).
-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "bill_to_address" TEXT,
ADD COLUMN     "bill_to_email" TEXT,
ADD COLUMN     "bill_to_name" TEXT;



-- Written by hand from here.

-- Invoices finalized before this migration get the customer's details as they are now (only test databases
-- have any). Row-level security is forced, so even the owner sees one organization at a time: each is made the
-- tenant in turn. The day-2 invoices_guard doesn't compare these new columns, so it lets the backfill through;
-- it is replaced below.
DO $$
DECLARE
    org record;
BEGIN
    FOR org IN SELECT id FROM organizations LOOP
        PERFORM set_config('app.organization_id', org.id::text, true);
        UPDATE invoices i SET bill_to_name = c.name, bill_to_email = c.email, bill_to_address = c.address
            FROM customers c
            WHERE c.organization_id = i.organization_id AND c.id = i.customer_id AND i.status <> 'DRAFT';
    END LOOP;
    PERFORM set_config('app.organization_id', '', true);
END
$$;

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bill_to_when_final" CHECK (
    ("status" = 'DRAFT') = ("bill_to_name" IS NULL) AND ("status" = 'DRAFT') = ("bill_to_email" IS NULL));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_bill_to_address_when_final" CHECK (
    "status" <> 'DRAFT' OR "bill_to_address" IS NULL);

-- The life cycle as before (migrations/*_invoicing, with *_review_d2's search_path), plus: finalization copies
-- the bill-to details, and they are frozen with everything else. The application has no grant on them.
CREATE OR REPLACE FUNCTION "invoices_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
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
        -- Who it's issued to, as the customer is now: later edits to the customer don't change it.
        SELECT name, email, address INTO NEW.bill_to_name, NEW.bill_to_email, NEW.bill_to_address
            FROM customers WHERE organization_id = NEW.organization_id AND id = NEW.customer_id;
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
        NEW.subtotal_minor, NEW.tax_minor, NEW.total_minor, NEW.bill_to_name, NEW.bill_to_email, NEW.bill_to_address)
       IS DISTINCT FROM
       (OLD.customer_id, OLD.currency, OLD.number, OLD.memo, OLD.issued_at, OLD.due_on,
        OLD.subtotal_minor, OLD.tax_minor, OLD.total_minor, OLD.bill_to_name, OLD.bill_to_email, OLD.bill_to_address) THEN
        RAISE EXCEPTION 'tally: invoice % is final; only its status can change', OLD.number USING ERRCODE = 'TL006';
    END IF;
    IF NEW.status = OLD.status OR (OLD.status = 'OPEN' AND NEW.status IN ('PAID', 'VOID')) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'tally: invoice % can''t go from % to %', OLD.number, OLD.status, NEW.status
        USING ERRCODE = 'TL007';
END
$$;

