// The migrations themselves: they produce exactly schema.prisma, and the invariants written into them by
// hand (CHECK constraints the schema language can't express) hold.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { adminDb, appDb, ownerUrl, unique } from "../helpers";

let app: Db;

beforeAll(() => {
  app = appDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
});

describe("the migrations", () => {
  it("leave the database exactly as schema.prisma describes it", () => {
    // Exits 2 if the migrated database and the schema differ (a model edited without a migration).
    const out = execFileSync(
      "node_modules/.bin/prisma",
      ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"],
      { env: { ...process.env, MIGRATE_DATABASE_URL: ownerUrl(), PRISMA_HIDE_UPDATE_MESSAGE: "1" }, encoding: "utf8" },
    );
    expect(out).toContain("No difference detected");
  });
});

describe("users", () => {
  const user = (email: string) => app.user.create({ data: { email, name: "N", passwordHash: "x" } });

  it("accept an email in its stored form", async () => {
    await expect(user(`ok-${unique()}@example.com`)).resolves.toMatchObject({ name: "N" });
  });

  it.each([["Upper@Example.com"], [" padded@example.com"], [""]])("refuse an email not in stored form: %j", async (email) => {
    await expect(user(email.replace("@", `-${unique()}@`))).rejects.toThrow(/users_email_normalized/);
  });

  it("refuse a second account with the same email", async () => {
    const email = `dup-${unique()}@example.com`;
    await user(email);
    await expect(user(email)).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("organization slugs", () => {
  const org = (slug: string) => app.organization.create({ data: { name: "N", slug } });

  it.each([["acme"], ["acme-inc"], ["a1-b2-c3"], ["x".repeat(63)]])("accept %s", async (slug) => {
    // Unique per run: only the shape matters here.
    const s = slug.length === 63 ? `${unique()}${slug.slice(12)}` : `${slug}-${unique()}`;
    await expect(org(s)).resolves.toMatchObject({ slug: s });
  });

  it.each([["Acme"], ["acme inc"], ["-acme"], ["acme-"], ["acme--inc"], ["acmé"], ["x".repeat(64)], [""]])(
    "refuse %j",
    async (slug) => {
      await expect(org(slug)).rejects.toThrow(/organizations_slug_format/);
    },
  );
});

describe("invoices and lines", () => {
  // Inside a tenant, as the application writes them.
  let orgId: string;
  let customerId: string;

  beforeAll(async () => {
    const { withTenant } = await import("@/server/db/tenant");
    const org = await app.organization.create({ data: { name: "Checks", slug: `checks-${unique()}` } });
    orgId = org.id;
    customerId = await withTenant(
      orgId,
      async (tx) => (await tx.customer.create({ data: { organizationId: orgId, name: "C", email: `c-${unique()}@example.com` } })).id,
      app,
    );
  });

  async function inTenant<T>(fn: (tx: import("@/server/db/tenant").TenantTx) => Promise<T>): Promise<T> {
    const { withTenant } = await import("@/server/db/tenant");
    return withTenant(orgId, fn, app);
  }

  const invoice = (data: Partial<{ currency: string; number: number | null; status: "DRAFT" | "OPEN" | "PAID" | "VOID" }>) =>
    inTenant((tx) => tx.invoice.create({ data: { organizationId: orgId, customerId, currency: "USD", ...data } }));

  it("accept a draft, which has no number", async () => {
    await expect(invoice({})).resolves.toMatchObject({ status: "DRAFT", number: null });
  });

  it.each([
    ["a lower-case currency", { currency: "usd" }, /invoices_currency_format/],
    // CHAR(3) pads "US" to "US ", which the format check refuses.
    ["a two-letter currency", { currency: "US" }, /invoices_currency_format/],
    // Only finalization assigns numbers (the invoices_guard trigger); the application has no grant on them.
    ["a number chosen by the application", { number: 7 }, /permission denied for table invoices/],
    ["a new invoice that isn't a draft", { status: "OPEN" as const }, /a new invoice must be a draft/],
  ])("refuse %s", async (_, data, constraint) => {
    await expect(invoice(data)).rejects.toThrow(constraint);
  });

  describe("with the triggers switched off (a superuser), the CHECK constraints still hold", () => {
    // session_replication_role = replica skips ordinary triggers: what's left is the constraints.
    async function insertWithoutTriggers(rows: string[]): Promise<void> {
      const admin = adminDb({ max: 1 });
      try {
        await admin.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
          for (const row of rows) {
            await tx.$executeRawUnsafe(
              `INSERT INTO invoices (organization_id, customer_id, currency, status, number, issued_at, due_on,
                                     subtotal_minor, tax_minor, total_minor, bill_to_name, bill_to_email)
               VALUES ($1::uuid, $2::uuid, 'USD', ${row})`,
              orgId,
              customerId,
            );
          }
          throw new Error("rolled back");
        });
      } finally {
        await admin.$disconnect();
      }
    }
    const billTo = "'N', 'n@example.com'";
    const final = `now(), current_date, 100, 0, 100, ${billTo}`;

    it.each([
      ["a draft with a number", `'DRAFT', 7, NULL, NULL, NULL, NULL, NULL, NULL, NULL`, /invoices_number_when_final/],
      ["an open invoice without a number", `'OPEN', NULL, ${final}`, /invoices_number_when_final/],
      ["a zero number", `'PAID', 0, ${final}`, /invoices_number_positive/],
      ["an open invoice without totals", `'OPEN', 1, now(), current_date, NULL, NULL, NULL, ${billTo}`, /invoices_final_fields/],
      ["a draft with totals", `'DRAFT', NULL, NULL, NULL, 1, 0, 1, NULL, NULL`, /invoices_final_fields/],
      ["a total that doesn't add up", `'OPEN', 1, now(), current_date, 100, 10, 111, ${billTo}`, /invoices_total_adds_up/],
      ["an open invoice without a bill-to", `'OPEN', 1, now(), current_date, 100, 0, 100, NULL, NULL`, /invoices_bill_to_when_final/],
      ["a draft with a bill-to", `'DRAFT', NULL, NULL, NULL, NULL, NULL, NULL, ${billTo}`, /invoices_bill_to_when_final/],
    ])("refuse %s", async (_, row, constraint) => {
      await expect(insertWithoutTriggers([row])).rejects.toThrow(constraint);
    });

    it("refuse a second invoice with the same number in one organization", async () => {
      const row = `'OPEN', 42, ${final}`;
      await expect(insertWithoutTriggers([row, row])).rejects.toThrow(/invoices_organization_id_number_key/);
      // The control: one such row is fine (and rolled back).
      await expect(insertWithoutTriggers([row])).rejects.toThrow(/rolled back/);
    });
  });

  describe("lines", () => {
    let invoiceId: string;

    beforeAll(async () => {
      invoiceId = (await invoice({})).id;
    });

    const line = (data: Partial<{ position: number; quantity: string; unitPriceMinor: bigint; taxRate: string }>) =>
      inTenant((tx) =>
        tx.invoiceLine.create({
          data: { organizationId: orgId, invoiceId, position: 1, description: "Work", quantity: "1", unitPriceMinor: 100n, ...data },
        }),
      );

    it("keep exact decimal quantities and integer minor units", async () => {
      const created = await line({ position: 1, quantity: "2.125", unitPriceMinor: 10_000_000_000n, taxRate: "8.875" });
      expect(created.quantity.toString()).toBe("2.125");
      expect(created.unitPriceMinor).toBe(10_000_000_000n);
      expect(created.taxRate.toFixed(3)).toBe("8.875");
    });

    it.each([
      ["a zero quantity", { position: 2, quantity: "0" }, /invoice_lines_quantity_positive/],
      ["a negative quantity", { position: 3, quantity: "-1" }, /invoice_lines_quantity_positive/],
      ["a negative price", { position: 4, unitPriceMinor: -1n }, /invoice_lines_unit_price_nonnegative/],
      ["position zero", { position: 0 }, /invoice_lines_position_positive/],
      // The limits money.ts also checks, so the largest invoice fits in bigint (DESIGN.md, "Money").
      ["a price over 10^10 minor units", { position: 5, unitPriceMinor: 10_000_000_001n }, /invoice_lines_unit_price_max/],
      ["a quantity over 1,000,000", { position: 6, quantity: "1000000.001" }, /invoice_lines_quantity_max/],
      ["a tax rate over 100%", { position: 7, taxRate: "100.001" }, /invoice_lines_tax_rate_range/],
      ["a negative tax rate", { position: 8, taxRate: "-1" }, /invoice_lines_tax_rate_range/],
    ])("refuse %s", async (_, data, constraint) => {
      await expect(line(data)).rejects.toThrow(constraint);
    });

    it("refuse two lines at the same position on one invoice", async () => {
      await line({ position: 10 });
      await expect(line({ position: 10 })).rejects.toMatchObject({ code: "P2002" });
    });
  });
});
