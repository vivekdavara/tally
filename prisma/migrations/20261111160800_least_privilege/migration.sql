-- DropForeignKey
ALTER TABLE "customers" DROP CONSTRAINT "customers_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_user_id_fkey";

-- DropIndex
DROP INDEX "invoice_lines_invoice_id_position_key";

-- DropIndex
DROP INDEX "invoice_lines_organization_id_invoice_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_organization_id_invoice_id_position_key" ON "invoice_lines"("organization_id", "invoice_id", "position");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- Written by hand from here: least privilege for the application role (review round 1).
--
-- Unique and primary-key checks, like foreign-key checks, run without row security. So whatever key a
-- client may choose, another tenant's use of it shows: an insert with another tenant's customer id failed
-- on customers_pkey where a random id succeeded. tally_app therefore may not choose ids at all (Postgres
-- generates them), may not change organization_id or any key, and has no DELETE on organizations or users,
-- whose ON DELETE CASCADE would run through another tenant's rows without row security.
REVOKE ALL ON "users", "organizations", "memberships", "customers", "invoices", "invoice_lines" FROM tally_app;

GRANT SELECT ON "users", "organizations", "memberships", "customers", "invoices", "invoice_lines" TO tally_app;

GRANT INSERT ("email", "name", "password_hash") ON "users" TO tally_app;
GRANT INSERT ("name", "slug"), UPDATE ("name", "slug") ON "organizations" TO tally_app;
GRANT INSERT ("organization_id", "user_id", "role"), UPDATE ("role"), DELETE ON "memberships" TO tally_app;
GRANT INSERT ("organization_id", "name", "email"), UPDATE ("name", "email"), DELETE ON "customers" TO tally_app;
GRANT INSERT ("organization_id", "customer_id", "number", "status", "currency"),
      UPDATE ("number", "status", "currency"), DELETE ON "invoices" TO tally_app;
GRANT INSERT ("organization_id", "invoice_id", "position", "description", "quantity", "unit_price_minor"),
      UPDATE ("position", "description", "quantity", "unit_price_minor"), DELETE ON "invoice_lines" TO tally_app;

-- Memberships decide who may act for an organization, so every layer trusts them. They stay readable
-- without a tenant (sign-in and slug resolution read them before one is known), but they can be written
-- only for the tenant of the current transaction: sign-up sets its new organization as the tenant before
-- inserting the first membership; invitations (day 4) run inside requireTenant.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_read" ON "memberships" FOR SELECT USING (true);
CREATE POLICY "memberships_insert" ON "memberships" FOR INSERT
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "memberships_update" ON "memberships" FOR UPDATE
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid)
    WITH CHECK ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "memberships_delete" ON "memberships" FOR DELETE
    USING ("organization_id" = NULLIF(current_setting('app.organization_id', true), '')::uuid);
