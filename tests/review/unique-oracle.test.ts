// REVIEW FINDING: unique indexes that don't start with organization_id are checked without row security, and
// before the (end-of-statement) foreign-key check, so they reopen the existence oracle DESIGN.md says the
// composite foreign keys close ("another tenant's customer id fails exactly like a random one").
//
// - invoice_lines has UNIQUE (invoice_id, position). A tenant that inserts (or moves) one of its own lines onto
//   another tenant's invoice id gets P2002 on invoice_lines_invoice_id_position_key when that invoice has a line
//   at that position, and P2003 (the composite FK) for a random id. So the failure differs.
// - Every tenant table's primary key is (id) alone, so an insert with an explicit id tells whether another
//   tenant already has a row with that id (P2002 on *_pkey vs success), and createMany({ skipDuplicates })
//   silently skips it (count 0 vs 1).
//
// Suggested fix: UNIQUE (organization_id, invoice_id, position) instead of (invoice_id, position); for the
// primary keys either PRIMARY KEY (organization_id, id) or never accept a client-supplied id (column-level
// INSERT grants that leave out "id", so the default is the only way in).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

let app: Db;
let a: { orgId: string; invoiceId: string };
let b: { orgId: string; customerId: string; invoiceId: string };

async function tenant(label: string) {
  const s = unique();
  const org = await app.organization.create({ data: { name: `${label} ${s}`, slug: `${label}-${s}` } });
  return withTenant(
    org.id,
    async (tx) => {
      const customer = await tx.customer.create({ data: { organizationId: org.id, name: "c", email: `c-${s}@example.com` } });
      const invoice = await tx.invoice.create({ data: { organizationId: org.id, customerId: customer.id, currency: "USD" } });
      await tx.invoiceLine.create({
        data: { organizationId: org.id, invoiceId: invoice.id, position: 1, description: "x", quantity: 1, unitPriceMinor: 1n },
      });
      return { orgId: org.id, customerId: customer.id, invoiceId: invoice.id };
    },
    app,
  );
}

beforeAll(async () => {
  app = appDb({ max: 4 });
  a = await tenant("oracle-a");
  b = await tenant("oracle-b");
});

afterAll(async () => {
  await app.$disconnect();
});

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { code?: string }) => e.code ?? String(e),
  );

describe("existence oracles across tenants", () => {
  it("a line pointed at another tenant's invoice fails like one pointed at a random id", async () => {
    const attempt = (invoiceId: string) =>
      codeOf(
        withTenant(
          a.orgId,
          (tx) =>
            tx.invoiceLine.create({
              data: { organizationId: a.orgId, invoiceId, position: 1, description: "probe", quantity: 1, unitPriceMinor: 1n },
            }),
          app,
        ),
      );
    const foreign = await attempt(b.invoiceId);
    const missing = await attempt(crypto.randomUUID());
    // Observed: foreign = "P2002" (invoice_lines_invoice_id_position_key), missing = "P2003".
    expect(foreign).toBe(missing);
  });

  it("moving one of its own lines onto another tenant's invoice fails like moving it onto a random id", async () => {
    const attempt = (invoiceId: string) =>
      codeOf(withTenant(a.orgId, (tx) => tx.invoiceLine.updateMany({ data: { invoiceId } }), app));
    expect(await attempt(b.invoiceId)).toBe(await attempt(crypto.randomUUID()));
  });

  it("an insert with an explicit id doesn't reveal whether another tenant uses that id", async () => {
    const attempt = (id: string) =>
      codeOf(
        withTenant(
          a.orgId,
          async (tx) => {
            await tx.customer.create({ data: { id, organizationId: a.orgId, name: "probe", email: `p-${unique()}@example.com` } });
            throw new Error("rollback"); // keep nothing
          },
          app,
        ),
      );
    // Observed: "P2002" (customers_pkey) for B's id, "rollback" (the insert succeeded) for a random one.
    expect(await attempt(b.customerId)).toBe(await attempt(crypto.randomUUID()));
  });

  it("createMany with skipDuplicates doesn't reveal another tenant's id by its count", async () => {
    const count = (id: string) =>
      withTenant(
        a.orgId,
        async (tx) => {
          const { count } = await tx.customer.createMany({
            data: [{ id, organizationId: a.orgId, name: "probe", email: `p-${unique()}@example.com` }],
            skipDuplicates: true,
          });
          throw Object.assign(new Error("rollback"), { count });
        },
        app,
      ).catch((e: { count?: number }) => e.count);
    // Observed: 0 for B's id (ON CONFLICT DO NOTHING hit B's row), 1 for a random one.
    expect(await count(b.customerId)).toBe(await count(crypto.randomUUID()));
  });
});
