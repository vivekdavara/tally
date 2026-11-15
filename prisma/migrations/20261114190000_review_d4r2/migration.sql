-- Review round 2 of day 4 (tests/review-d4r2/owner-guard-for-share-deadlocks.test.ts): round 1's fix locked the other
-- owners' rows FOR SHARE at every isolation level. Under READ COMMITTED that added a wait the check doesn't need, and a
-- raw-SQL writer that locks its target first (SELECT ... FOR UPDATE, then UPDATE) formed a cycle with it: a deadlock
-- (40P01) where the previous guard refused cleanly with TL018. Under READ COMMITTED each statement in this function
-- takes a fresh snapshot, so a plain read after the advisory lock already sees every owner change committed before
-- the lock was granted (every such change takes the same lock). Only the stricter levels, whose snapshot is older,
-- need the rows locked (a row changed since the snapshot is then a serialization failure).
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
    IF current_setting('transaction_isolation') = 'read committed' THEN
        PERFORM 1 FROM memberships
         WHERE organization_id = OLD.organization_id AND role = 'OWNER' AND user_id <> OLD.user_id;
    ELSE
        PERFORM 1 FROM memberships
         WHERE organization_id = OLD.organization_id AND role = 'OWNER' AND user_id <> OLD.user_id
           FOR SHARE;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'tally: an organization keeps at least one owner' USING ERRCODE = 'TL018';
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;
