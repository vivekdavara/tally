-- created_at comes from the database's clock: Prisma omits the column on insert (dbgenerated), so the
-- application role needs no grant on it and can't set it. clock_timestamp() is the moment the row is written;
-- it is also the spelling Prisma's schema diff reads back unchanged (CURRENT_TIMESTAMP and now() never
-- compare equal to their dbgenerated form, so the drift test would always fail).
ALTER TABLE "users" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
ALTER TABLE "organizations" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
ALTER TABLE "memberships" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
ALTER TABLE "customers" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
ALTER TABLE "invoices" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
