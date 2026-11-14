-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "membership_role" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "invited_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
    "expires_at" TIMESTAMPTZ(3) NOT NULL DEFAULT (clock_timestamp() + '7 days'::interval),
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by" UUID,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_id_key" ON "invitations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_organization_id_token_hash_key" ON "invitations"("organization_id", "token_hash");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;



-- Written by hand from here: members and invitations (DESIGN.md, "Members and invitations").

-- An organization always has an owner. Removing or demoting an owner is refused when no other owner would be left.
-- Two owners demoting each other at once: each request locks only its own target's row, so both would see the
-- other still an owner; the advisory lock (per organization, held to the end of the transaction) makes them take
-- turns, and the second, reading the committed state in its next statement (READ COMMITTED), is refused.
-- Deleting a user or an organization (an administrator, as the owner role; the app can do neither) cascades here
-- as a nested statement, pg_trigger_depth() > 1, and is let through.
CREATE FUNCTION "memberships_guard"() RETURNS trigger
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
    IF NOT EXISTS (SELECT 1 FROM memberships
                    WHERE organization_id = OLD.organization_id AND role = 'OWNER' AND user_id <> OLD.user_id) THEN
        RAISE EXCEPTION 'tally: an organization keeps at least one owner' USING ERRCODE = 'TL018';
    END IF;
    RETURN COALESCE(NEW, OLD);
END
$$;

CREATE TRIGGER "memberships_guard" BEFORE UPDATE OR DELETE ON "memberships"
    FOR EACH ROW EXECUTE FUNCTION "memberships_guard"();

-- Shapes the application relies on. Emails in the stored form users have (trimmed, lower-case); the token is a
-- SHA-256 digest (the link carries the token itself, which is never stored).
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_normalized" CHECK ("email" = lower(btrim("email")) AND "email" LIKE '%_@_%' AND length("email") <= 254);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_token_hash_length" CHECK (octet_length("token_hash") = 32);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_together" CHECK (("accepted_at" IS NULL) = ("accepted_by" IS NULL));
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_closed_once" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);

-- At most one open invitation per address: inviting again revokes the old link first, so only the newest works.
CREATE UNIQUE INDEX "invitations_one_open_per_email" ON "invitations" ("organization_id", "email")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- Column by column, as in *_least_privilege: who, what role and which token are written once; afterwards only
-- whether it was accepted (and by whom) or revoked. Times come from the database's clock (the trigger), never
-- the application's. Nothing is deleted.
GRANT SELECT,
      INSERT ("organization_id", "email", "role", "token_hash", "invited_by"),
      UPDATE ("accepted_by", "revoked_at")
    ON "invitations" TO tally_app;

-- An invitation is created open and closed once: accepted (before it expires, by someone) or revoked. SQLSTATE
-- TL019.
CREATE FUNCTION "invitations_guard"() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.accepted_at IS NOT NULL OR NEW.accepted_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
            RAISE EXCEPTION 'tally: a new invitation starts open' USING ERRCODE = 'TL019';
        END IF;
        NEW.created_at := clock_timestamp();
        NEW.expires_at := NEW.created_at + interval '7 days';
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- Only the organization's own deletion removes invitations.
        IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
            RAISE EXCEPTION 'tally: invitations are kept' USING ERRCODE = 'TL019';
        END IF;
        RETURN OLD;
    END IF;
    IF (NEW.id, NEW.organization_id, NEW.email, NEW.role, NEW.token_hash, NEW.invited_by, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM
       (OLD.id, OLD.organization_id, OLD.email, OLD.role, OLD.token_hash, OLD.invited_by, OLD.created_at, OLD.expires_at) THEN
        RAISE EXCEPTION 'tally: only whether an invitation was accepted or revoked can change' USING ERRCODE = 'TL019';
    END IF;
    IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'tally: this invitation was already used or revoked' USING ERRCODE = 'TL020';
    END IF;
    IF NEW.accepted_by IS NOT NULL THEN
        IF OLD.expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'tally: this invitation has expired' USING ERRCODE = 'TL020';
        END IF;
        NEW.accepted_at := clock_timestamp();
    ELSIF NEW.revoked_at IS NOT NULL THEN
        NEW.revoked_at := clock_timestamp();
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER "invitations_guard" BEFORE INSERT OR UPDATE OR DELETE ON "invitations"
    FOR EACH ROW EXECUTE FUNCTION "invitations_guard"();
