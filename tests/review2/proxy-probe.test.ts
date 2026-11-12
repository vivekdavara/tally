// Round 2 probe of withTenant's tracking proxy (all pass at e98f346): the Prisma APIs a tx caller might use.
// "a promise never awaited doesn't run" also kills the eager-start mutant (start() before `return {`), which the
// existing suite lets through.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

let app: Db;
let org: { id: string };
let customerId: string;


beforeAll(async () => {
  app = appDb({ max: 2 });
  const s = unique();
  org = await app.organization.create({ data: { name: `probe ${s}`, slug: `probe-${s}` } });
  ({ customerId } = await withTenant(
    org.id,
    async (tx) => {
      const c = await tx.customer.create({ data: { organizationId: org.id, name: "c", email: `c-${s}@example.com` } });
      const i = await tx.invoice.create({ data: { organizationId: org.id, customerId: c.id, currency: "USD" } });
      await tx.invoiceLine.create({
        data: { organizationId: org.id, invoiceId: i.id, position: 1, description: "x", quantity: "1.5", unitPriceMinor: 1234567890n },
      });
      return { customerId: c.id, invoiceId: i.id };
    },
    app,
  ));
});

afterAll(async () => {
  await app.$disconnect();
});

const run = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(org.id, fn, app);

describe("withTenant's tx view", () => {
  it("tagged-template and Unsafe raw queries", async () => {
    const out = await run(async (tx) => ({
      q: await tx.$queryRaw<{ n: number }[]>`SELECT ${41}::int + 1 AS n`,
      e: await tx.$executeRaw`UPDATE customers SET name = name WHERE id = ${customerId}::uuid`,
      qu: await tx.$queryRawUnsafe<{ n: number }[]>("SELECT $1::int AS n", 7),
      eu: await tx.$executeRawUnsafe("UPDATE customers SET name = name WHERE id = $1::uuid", customerId),
      sql: await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT ${3}::int AS n`),
    }));
    expect(out).toEqual({ q: [{ n: 42 }], e: 1, qu: [{ n: 7 }], eu: 1, sql: [{ n: 3 }] });
  });

  it("createManyAndReturn, aggregate, groupBy with Decimal and BigInt", async () => {
    const out = await run(async (tx) => {
      const made = await tx.customer.createManyAndReturn({
        data: [{ organizationId: org.id, name: "m", email: `m-${unique()}@example.com` }],
        select: { id: true },
      });
      const agg = await tx.invoiceLine.aggregate({ _sum: { quantity: true, unitPriceMinor: true } });
      const grouped = await tx.invoiceLine.groupBy({ by: ["invoiceId"], _sum: { unitPriceMinor: true } });
      return { made, agg, grouped };
    });
    expect(out.made).toHaveLength(1);
    expect(Prisma.Decimal.isDecimal(out.agg._sum.quantity)).toBe(true);
    expect(out.agg._sum.unitPriceMinor).toBe(1234567890n);
    expect(out.grouped[0]?._sum.unitPriceMinor).toBe(1234567890n);
  });

  it("awaiting the same promise twice runs it once; .catch/.finally chain", async () => {
    const email = `twice-${unique()}@example.com`;
    await run(async (tx) => {
      const p = tx.customer.create({ data: { organizationId: org.id, name: "t", email } });
      await p;
      await p;
      await p.finally(() => undefined);
      const caught = await tx.customer.create({ data: { organizationId: org.id, name: "t", email: "x" } }).catch(() => "c");
      expect(caught).not.toBe("c");
    });
    expect(await run((tx) => tx.customer.count({ where: { email } }))).toBe(1);
  });

  it("a promise never awaited doesn't run", async () => {
    const email = `never-${unique()}@example.com`;
    await run(async (tx) => {
      void tx.customer.create({ data: { organizationId: org.id, name: "n", email } });
    });
    expect(await run((tx) => tx.customer.count({ where: { email } }))).toBe(0);
  });

  it("field references", async () => {
    const n = await run((tx) => tx.invoiceLine.count({ where: { position: { lte: tx.invoiceLine.fields.position } } }));
    expect(n).toBe(1);
  });
});
