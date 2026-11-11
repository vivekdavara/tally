// REVIEW 2 FINDING: c6583bb's tracking proxy breaks Prisma's fluent relation API inside withTenant.
// tracked() returns a bare { then, catch, finally } object, so the relation methods Prisma puts on the
// promise a findUnique/findFirst returns (tx.customer.findUnique(...).invoices()) are gone: TypeError at
// runtime, while TypeScript still types the call as valid (the proxy claims to return T). Nothing in the app
// uses it yet; D2's "an invoice's lines" / "a customer's invoices" pages are the natural place it would.
//
// Suggested fix: make tracked() keep the lazy promise's other members, e.g. return a Proxy over `lazy`
// whose get trap substitutes then/catch/finally and wraps any other function-valued member's result with
// tracked() again (fluent calls return Prisma promises too); or drop the per-promise wrapper and track
// at the transaction level instead.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

let app: Db;
let org: { id: string };
let customerId: string;
let invoiceId: string;

beforeAll(async () => {
  app = appDb({ max: 2 });
  const s = unique();
  org = await app.organization.create({ data: { name: `fluent ${s}`, slug: `fluent-${s}` } });
  ({ customerId, invoiceId } = await withTenant(
    org.id,
    async (tx) => {
      const c = await tx.customer.create({ data: { organizationId: org.id, name: "c", email: `c-${s}@example.com` } });
      const i = await tx.invoice.create({ data: { organizationId: org.id, customerId: c.id, currency: "USD" } });
      return { customerId: c.id, invoiceId: i.id };
    },
    app,
  ));
});

afterAll(async () => {
  await app.$disconnect();
});

describe("Prisma's fluent API on withTenant's tx", () => {
  it("works on a plain transaction client (control)", async () => {
    const invoices = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${org.id}, true)`;
      return tx.customer.findUnique({ where: { id: customerId } }).invoices();
    });
    expect(invoices?.map((i) => i.id)).toEqual([invoiceId]);
  });

  it("works on withTenant's tx", async () => {
    // Observed: TypeError: tx.customer.findUnique(...).invoices is not a function
    const invoices = await withTenant(org.id, (tx) => tx.customer.findUnique({ where: { id: customerId } }).invoices(), app);
    expect(invoices?.map((i) => i.id)).toEqual([invoiceId]);
  });
});
