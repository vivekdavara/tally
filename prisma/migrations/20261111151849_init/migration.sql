-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "membership_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("organization_id","user_id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "number" INTEGER,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_id_key" ON "customers"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_email_key" ON "customers"("organization_id", "email");

-- CreateIndex
CREATE INDEX "invoices_organization_id_customer_id_idx" ON "invoices"("organization_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_id_key" ON "invoices"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_organization_id_number_key" ON "invoices"("organization_id", "number");

-- CreateIndex
CREATE INDEX "invoice_lines_organization_id_invoice_id_idx" ON "invoice_lines"("organization_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoice_id_position_key" ON "invoice_lines"("invoice_id", "position");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_customer_id_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "customers"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_invoice_id_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "invoices"("organization_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- Invariants the schema language can't state (written by hand).
-- Emails are stored in the form the application looks them up by.
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")) AND "email" <> '');
-- Slugs appear in URLs: lower-case words joined by single hyphens, at most 63 characters.
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_format"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") <= 63);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number_positive" CHECK ("number" > 0);
-- A draft has no number; anything that has left draft has one.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number_when_final" CHECK (("status" = 'DRAFT') = ("number" IS NULL));
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_position_positive" CHECK ("position" > 0);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_unit_price_nonnegative" CHECK ("unit_price_minor" >= 0);
