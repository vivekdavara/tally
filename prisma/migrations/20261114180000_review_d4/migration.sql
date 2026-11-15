-- Review of day 4 (tests/review-d4/last-owner-repeatable-read.test.ts): memberships_guard asked "is another owner
-- left?" with a plain SELECT, which reads the transaction's snapshot. Under READ COMMITTED that snapshot is taken
-- after the advisory lock wait, so it sees a concurrent demotion that committed meanwhile. But a raw-SQL writer picks
-- its own isolation level: under REPEATABLE READ or SERIALIZABLE the snapshot predates that demotion, each transaction
-- changes a different row, and both committed, leaving no owner. The other owners' rows are now locked FOR SHARE:
-- under READ COMMITTED that reads each row's latest committed version, and under the stricter levels a row changed
-- since the snapshot is a serialization failure (40001) instead of a stale "yes".
CREATE OR REPLACE FUNCTION "memberships_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.organization_id, NEW.user_id, NEW.created_at) IS DISTINCT FROM (OLD.organization_id, OLD.user_id, OLD.created_at) THEN
        RAISE EXCEPTION 'tally: only a membership''s role can change' USING ERRCODE = 'TL017';
    END IF;
    IF OLD.role <> 'OWNER' OR (TG_OP = 'UPDATE' AND NEW.role = 'OWNER') OR pg_trigger_depth() > 1 THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('tally.owners:' || OLD.organization_id::text, 0));
    PERFORM 1 FROM memberships
     WHERE organization_id = OLD.organization_id AND role = 'OWNER' AND user_id <> OLD.user_id
       FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tally: an organization keeps at least one owner' USING ERRCODE = 'TL018';
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;
