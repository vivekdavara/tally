-- Row-level security for every tenant-owned table, and the application role's privileges.
-- DESIGN.md, "Layer 3", explains each choice; tests/integration/rls.test.ts proves them.
--
-- The tenant is the transaction-local setting app.organization_id, set by withTenant() with
-- set_config(..., true). current_setting(..., true) is NULL if the setting was never set in this session
-- and '' if a transaction set it and has since ended; NULLIF maps both to NULL, which matches no row. So a
-- query with no tenant sees nothing and can write nothing. The expression is inline (not a function) so the
-- planner treats it as a constant and can use the (organization_id, ...) indexes.

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customers"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoices"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_lines"
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- The application role (created by scripts/db-setup.sh): data manipulation on the application's tables,
-- nothing else. Not on _prisma_migrations, so the running app can't rewrite migration history. No sequences:
-- every id is a UUID.
GRANT USAGE ON SCHEMA public TO tally_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "users", "organizations", "memberships", "customers", "invoices", "invoice_lines"
    TO tally_app;
