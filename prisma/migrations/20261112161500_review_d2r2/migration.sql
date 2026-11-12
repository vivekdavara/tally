-- Review round 2 of day 2 (tests/review-d2r2/). Written by hand; no schema change.
--
-- Deleting an organization with a final invoice worked only because Postgres happened to fire the invoices
-- cascade before the invoice_lines one (RI triggers fire in name order, RI_ConstraintTrigger_a_<oid>, so in
-- foreign-key creation order): with the lines' cascade first, invoice_lines_guard still found the OPEN invoice and
-- refused (TL008). invoices_guard already lets the organization's own cascade through; the lines guard now does
-- the same, whatever the order.
CREATE OR REPLACE FUNCTION "invoice_lines_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    line invoice_lines%ROWTYPE;
    invoice_status invoice_status;
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.invoice_id, NEW.organization_id) IS DISTINCT FROM (OLD.invoice_id, OLD.organization_id) THEN
        RAISE EXCEPTION 'tally: a line can''t move to another invoice' USING ERRCODE = 'TL008';
    END IF;
    IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
    SELECT status INTO invoice_status FROM invoices
        WHERE organization_id = line.organization_id AND id = line.invoice_id
        FOR NO KEY UPDATE;
    IF FOUND THEN
        IF invoice_status <> 'DRAFT'
           AND NOT (TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM organizations WHERE id = line.organization_id)) THEN
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
