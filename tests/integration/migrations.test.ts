// The migrations themselves: they produce exactly schema.prisma, and the invariants written into them by
// hand (CHECK constraints the schema language can't express) hold.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { appDb, ownerUrl, unique } from "../helpers";

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

  it("accept a draft without a number and a finalized invoice with one", async () => {
    await expect(invoice({})).resolves.toMatchObject({ status: "DRAFT", number: null });
    await expect(invoice({ status: "OPEN", number: 1 })).resolves.toMatchObject({ number: 1 });
  });

  it.each([
    ["a lower-case currency", { currency: "usd" }, /invoices_currency_format/],
    // CHAR(3) pads "US" to "US ", which the format check refuses.
    ["a two-letter currency", { currency: "US" }, /invoices_currency_format/],
    ["a draft with a number", { number: 7 }, /invoices_number_when_final/],
    ["an open invoice without a number", { status: "OPEN" as const }, /invoices_number_when_final/],
    ["a zero number", { status: "PAID" as const, number: 0 }, /invoices_number_positive/],
  ])("refuse %s", async (_, data, constraint) => {
    await expect(invoice(data)).rejects.toThrow(constraint);
  });

  it("refuse a second invoice with the same number in one organization", async () => {
    await invoice({ status: "OPEN", number: 42 });
    await expect(invoice({ status: "OPEN", number: 42 })).rejects.toMatchObject({ code: "P2002" });
  });

  describe("lines", () => {
    let invoiceId: string;

    beforeAll(async () => {
      invoiceId = (await invoice({})).id;
    });

    const line = (data: Partial<{ position: number; quantity: string; unitPriceMinor: bigint }>) =>
      inTenant((tx) =>
        tx.invoiceLine.create({
          data: { organizationId: orgId, invoiceId, position: 1, description: "Work", quantity: "1", unitPriceMinor: 100n, ...data },
        }),
      );

    it("keep exact decimal quantities and integer minor units", async () => {
      const created = await line({ position: 1, quantity: "2.125", unitPriceMinor: 9_007_199_254_740_993n });
      expect(created.quantity.toString()).toBe("2.125");
      // Beyond Number.MAX_SAFE_INTEGER: a bigint survives the round trip exactly.
      expect(created.unitPriceMinor).toBe(9_007_199_254_740_993n);
    });

    it.each([
      ["a zero quantity", { position: 2, quantity: "0" }, /invoice_lines_quantity_positive/],
      ["a negative quantity", { position: 3, quantity: "-1" }, /invoice_lines_quantity_positive/],
      ["a negative price", { position: 4, unitPriceMinor: -1n }, /invoice_lines_unit_price_nonnegative/],
      ["position zero", { position: 0 }, /invoice_lines_position_positive/],
    ])("refuse %s", async (_, data, constraint) => {
      await expect(line(data)).rejects.toThrow(constraint);
    });

    it("refuse two lines at the same position on one invoice", async () => {
      await line({ position: 10 });
      await expect(line({ position: 10 })).rejects.toMatchObject({ code: "P2002" });
    });
  });
});
