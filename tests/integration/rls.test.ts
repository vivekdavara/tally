// Row-level security, proved against a real Postgres as the application's own role (DESIGN.md, "Layer 3").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { TENANT_TABLES, withTenant } from "@/server/db/tenant";
import { appDb, ownerDb, unique } from "../helpers";

interface Tenant {
  orgId: string;
  customerIds: string[];
  invoiceId: string;
  lineId: string;
}

let app: Db;
let a: Tenant;
let b: Tenant;

async function makeTenant(client: Db, label: string): Promise<Tenant> {
  const suffix = unique();
  const org = await client.organization.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}` } });
  return withTenant(
    org.id,
    async (tx) => {
      const c1 = await tx.customer.create({
        data: { organizationId: org.id, name: `${label} one`, email: `one-${suffix}@example.com` },
      });
      const c2 = await tx.customer.create({
        data: { organizationId: org.id, name: `${label} two`, email: `two-${suffix}@example.com` },
      });
      const invoice = await tx.invoice.create({
        data: { organizationId: org.id, customerId: c1.id, currency: "USD" },
      });
      const line = await tx.invoiceLine.create({
        data: {
          organizationId: org.id,
          invoiceId: invoice.id,
          position: 1,
          description: "Consulting",
          quantity: "1.500",
          unitPriceMinor: 12_000n,
        },
      });
      return { orgId: org.id, customerIds: [c1.id, c2.id], invoiceId: invoice.id, lineId: line.id };
    },
    client,
  );
}

beforeAll(async () => {
  app = appDb();
  a = await makeTenant(app, "alpha");
  b = await makeTenant(app, "beta");
});

afterAll(async () => {
  await app.$disconnect();
});

describe("without a tenant", () => {
  it("sees no rows, though both tenants have some", async () => {
    expect(await app.customer.findMany({ where: { id: { in: [...a.customerIds, ...b.customerIds] } } })).toEqual([]);
    expect(await app.invoice.count()).toBe(0);
    expect(await app.invoiceLine.count()).toBe(0);
    const raw = await app.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM customers`;
    expect(raw[0]?.n).toBe(0n);
  });

  it("can insert nothing", async () => {
    await expect(
      app.customer.create({ data: { organizationId: a.orgId, name: "x", email: `x-${unique()}@example.com` } }),
    ).rejects.toThrow(/row-level security/);
  });

  it("sees no rows after a transaction set the tenant on the same connection and ended", async () => {
    // One connection, so the second query is certain to run where the first transaction did. Postgres
    // leaves the setting as '' (not NULL) after a transaction-local set ends: the NULLIF case.
    const single = appDb({ max: 1 });
    try {
      const inside = await withTenant(a.orgId, (tx) => tx.customer.count(), single);
      expect(inside).toBe(2);
      const after = await single.$queryRaw<{ setting: string | null }[]>`
        SELECT current_setting('app.organization_id', true) AS setting`;
      expect(after[0]?.setting).toBe("");
      expect(await single.customer.count()).toBe(0);
    } finally {
      await single.$disconnect();
    }
  });

  it("would leak to the next transaction if the setting were session-level, which is why withTenant doesn't use one", async () => {
    // The hazard withTenant's `true` avoids: set_config(..., false) outlives its transaction.
    const single = appDb({ max: 1 });
    try {
      await single.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${a.orgId}, false)`;
      });
      expect(await single.customer.count()).toBe(2);
    } finally {
      await single.$disconnect();
    }
  });
});

describe("inside withTenant", () => {
  it("sees exactly its own tenant's rows in every tenant table", async () => {
    const seen = await withTenant(
      a.orgId,
      async (tx) => ({
        customers: (await tx.customer.findMany({ orderBy: { name: "asc" } })).map((c) => c.id),
        invoices: (await tx.invoice.findMany()).map((i) => i.id),
        lines: (await tx.invoiceLine.findMany()).map((l) => l.id),
      }),
      app,
    );
    expect(seen).toEqual({ customers: a.customerIds, invoices: [a.invoiceId], lines: [a.lineId] });
  });

  it("applies to raw SQL too, not only to Prisma's queries", async () => {
    const rows = await withTenant(
      b.orgId,
      (tx) => tx.$queryRaw<{ organization_id: string }[]>`SELECT DISTINCT organization_id FROM invoices`,
      app,
    );
    expect(rows).toEqual([{ organization_id: b.orgId }]);
  });

  it("can't find another tenant's row by its id", async () => {
    const found = await withTenant(a.orgId, (tx) => tx.customer.findUnique({ where: { id: b.customerIds[0] } }), app);
    expect(found).toBeNull();
  });

  it("can't update or delete another tenant's rows: they match nothing", async () => {
    const result = await withTenant(
      a.orgId,
      async (tx) => ({
        updated: (await tx.customer.updateMany({ where: { id: { in: b.customerIds } }, data: { name: "taken" } }))
          .count,
        deleted: (await tx.invoiceLine.deleteMany({ where: { id: b.lineId } })).count,
      }),
      app,
    );
    expect(result).toEqual({ updated: 0, deleted: 0 });
    const intact = await withTenant(b.orgId, (tx) => tx.customer.findMany({ select: { name: true } }), app);
    expect(intact.map((c) => c.name).sort()).toEqual(["beta one", "beta two"]);
  });

  it("refuses to insert a row for another tenant", async () => {
    await expect(
      withTenant(
        a.orgId,
        (tx) => tx.customer.create({ data: { organizationId: b.orgId, name: "x", email: `x-${unique()}@example.com` } }),
        app,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses to move its own row to another tenant", async () => {
    await expect(
      withTenant(
        a.orgId,
        (tx) => tx.$executeRaw`UPDATE customers SET organization_id = ${b.orgId}::uuid WHERE id = ${a.customerIds[1]}::uuid`,
        app,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("can't reference another tenant's customer, and the error is the same as for an id that doesn't exist", async () => {
    const attempt = (customerId: string) =>
      withTenant(a.orgId, (tx) => tx.invoice.create({ data: { organizationId: a.orgId, customerId, currency: "USD" } }), app);
    const foreign = await attempt(b.customerIds[0]!).catch((e: unknown) => e);
    const missing = await attempt(crypto.randomUUID()).catch((e: unknown) => e);
    expect(foreign).toMatchObject({ code: "P2003" });
    expect(missing).toMatchObject({ code: "P2003" });
    // The same constraint, and the same message once ids (and anything id-shaped, such as a checkout path
    // with a UUID in it) are blanked the same way in both.
    expect((foreign as { meta: unknown }).meta).toEqual((missing as { meta: unknown }).meta);
    const blank = (e: unknown) => String((e as Error).message).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>");
    expect(blank(foreign)).toBe(blank(missing));
  });

  it("gives queries made on another client inside the callback no tenant", async () => {
    const outside = await withTenant(a.orgId, async () => app.customer.count(), app);
    expect(outside).toBe(0);
  });

  it("refuses a malformed tenant id before touching the database", async () => {
    await expect(withTenant("'; DROP TABLE customers; --", async () => 1, app)).rejects.toThrow(TypeError);
  });

  it("fails loudly on a malformed setting rather than matching anything", async () => {
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.organization_id', 'not-a-uuid', true)`;
        return tx.customer.count();
      }),
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it("keeps concurrent tenants apart on a shared pool", async () => {
    const shared = appDb({ max: 3 });
    try {
      const rounds = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? a : b));
      const results = await Promise.all(
        rounds.map((t) =>
          withTenant(
            t.orgId,
            async (tx) => {
              const ids = (await tx.customer.findMany({ select: { organizationId: true } })).map((c) => c.organizationId);
              return { expected: t.orgId, ids };
            },
            shared,
          ),
        ),
      );
      for (const r of results) {
        expect(r.ids).toEqual([r.expected, r.expected]);
      }
    } finally {
      await shared.$disconnect();
    }
  });
});

describe("the schema", () => {
  it("protects every table that has an organization_id, except memberships, with forced row-level security", async () => {
    const owner = ownerDb({ max: 1 });
    try {
      const rows = await owner.$queryRaw<{ table: string; rls: boolean; forced: boolean; policies: bigint }[]>`
        SELECT c.relname::text AS "table", c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
          AND c.relname <> 'memberships'
        ORDER BY 1`;
      expect(rows.map((r) => r.table)).toEqual([...TENANT_TABLES].sort());
      for (const r of rows) {
        expect(r, r.table).toMatchObject({ rls: true, forced: true, policies: 1n });
      }
    } finally {
      await owner.$disconnect();
    }
  });

  it("gives the app role no access to the migration history", async () => {
    await expect(app.$queryRaw`SELECT count(*) FROM _prisma_migrations`).rejects.toThrow(/permission denied/);
  });

  it("cascades an organization's deletion through its customers, invoices and lines", async () => {
    const t = await makeTenant(app, "gamma");
    await app.organization.delete({ where: { id: t.orgId } });
    const left = await withTenant(
      t.orgId,
      async (tx) => (await tx.customer.count()) + (await tx.invoice.count()) + (await tx.invoiceLine.count()),
      app,
    );
    expect(left).toBe(0);
  });

  it("won't delete a customer that still has invoices", async () => {
    await expect(
      withTenant(a.orgId, (tx) => tx.customer.delete({ where: { id: a.customerIds[0] } }), app),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});
