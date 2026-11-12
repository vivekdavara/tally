-- Review of day 2 (tests/review-d2/). Written by hand; nothing here changes the Prisma schema.

-- 1. The counter could be written by any tally_app statement: UPDATE invoice_counters SET last_number =
--    last_number + 41 made the next invoice number 43, a gap. The application needs INSERT/UPDATE on it only
--    because invoices_guard (SECURITY INVOKER) runs as the application. So the counter now accepts a write only
--    from inside another trigger (pg_trigger_depth() > 1: invoices_guard is level 1, this guard level 2; tally_app
--    can't create triggers, so invoices_guard is the only such writer), and only one step at a time: an insert
--    starts at 1, an update adds exactly 1.
CREATE FUNCTION "invoice_counters_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'tally: invoice numbers are assigned only by finalizing an invoice' USING ERRCODE = 'TL010';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.last_number <> 1 THEN
        RAISE EXCEPTION 'tally: a counter starts at 1' USING ERRCODE = 'TL010';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.last_number <> OLD.last_number + 1 OR NEW.organization_id <> OLD.organization_id) THEN
        RAISE EXCEPTION 'tally: a counter only moves up by one' USING ERRCODE = 'TL010';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER "invoice_counters_guard" BEFORE INSERT OR UPDATE ON "invoice_counters"
    FOR EACH ROW EXECUTE FUNCTION "invoice_counters_guard"();

-- 2. search_path = pg_catalog, public put the session's temporary schema first for tables (it is searched first
--    unless listed), so with TEMP a session could shadow invoice_lines or invoices for the triggers: a temp
--    invoice_lines made finalization store a total of 1 for a real line of 100000. pg_temp listed last is
--    searched last. (tally_app has no TEMP today; the role check now refuses it as well.)
ALTER FUNCTION "invoice_totals"(uuid, uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION "invoices_guard"() SET search_path = pg_catalog, public, pg_temp;

-- 3. invoice_lines_guard checked only the invoice in NEW, so an UPDATE of invoice_id (no grant today) could move a
--    line out of a final invoice into a draft. A line now never changes invoice or organization.
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
