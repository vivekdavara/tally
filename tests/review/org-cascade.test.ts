// REVIEW FINDING: organizations and memberships have no row-level security and tally_app has full DML on
// them, so ordinary Prisma calls made inside one tenant's withTenant change another tenant's data:
//
// - Deleting another organization's row cascades (ON DELETE CASCADE) through its customers, invoices and
//   lines. Foreign-key actions run as the table owner without row security, so RLS on the tenant tables
//   never sees the deletes.
// - Changing another organization's id cascades (ON UPDATE CASCADE) into organization_id of all its tenant
//   rows the same way.
// - Inserting a membership into another organization is accepted, and requireMembership (layer 1) then
//   trusts it, so layers 2 and 3 serve that organization's rows. One bug in a future "join"/"invite" action
//   that takes the organization id from the form is a full cross-tenant takeover.
//
// DESIGN.md's opening promise is that no request on behalf of one organization can change another's data
// "even when the application code has a bug"; these are single-call bugs that get through all three layers.
//
// Suggested fix: revoke DELETE on organizations and UPDATE of organizations.id from tally_app (column-level
// GRANT UPDATE (name, slug)), make the organization FKs ON UPDATE NO ACTION (ids never change), and give
// memberships a policy (e.g. writes only with app.organization_id set to that organization, plus a
// SECURITY DEFINER function owned by tally_owner for sign-up's first membership).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { findMembership } from "@/server/orgs/memberships";
import { appDb, unique } from "../helpers";

let app: Db;

async function tenant(label: string) {
  const s = unique();
  const org = await app.organization.create({ data: { name: `${label} ${s}`, slug: `${label}-${s}` } });
  await withTenant(
    org.id,
    async (tx) => {
      const c = await tx.customer.create({ data: { organizationId: org.id, name: "c", email: `c-${s}@example.com` } });
      await tx.invoice.create({ data: { organizationId: org.id, customerId: c.id, currency: "USD" } });
    },
    app,
  );
  return org;
}

const rowsOf = (orgId: string) =>
  withTenant(orgId, async (tx) => (await tx.customer.count()) + (await tx.invoice.count()), app);

beforeAll(() => {
  app = appDb({ max: 4 });
});

afterAll(async () => {
  await app.$disconnect();
});

describe("writes to another organization from inside a tenant transaction", () => {
  it("can't delete another organization's customers and invoices by deleting its organization row", async () => {
    const a = await tenant("cascade-a");
    const b = await tenant("cascade-b");
    expect(await rowsOf(b.id)).toBe(2);
    // As tenant A: one ordinary Prisma call with B's id (say, from a URL).
    await withTenant(a.id, (tx) => tx.organization.delete({ where: { id: b.id } }), app).catch(() => undefined);
    // Observed: 0. The delete succeeded and cascaded through B's tenant rows.
    expect(await rowsOf(b.id)).toBe(2);
  });

  it("can't rewrite another organization's tenant rows by changing its id", async () => {
    const a = await tenant("rekey-a");
    const b = await tenant("rekey-b");
    const newId = crypto.randomUUID();
    await withTenant(a.id, (tx) => tx.organization.update({ where: { id: b.id }, data: { id: newId } }), app).catch(
      () => undefined,
    );
    // Observed: B's rows now all carry organization_id = newId (written by the cascade, not under RLS).
    expect(await rowsOf(b.id)).toBe(2);
  });

  it("can't make the user a member of another organization", async () => {
    const a = await tenant("join-a");
    const b = await tenant("join-b");
    const s = unique();
    const user = await app.user.create({ data: { email: `m-${s}@example.com`, name: "M", passwordHash: "x" } });
    // (Fixture: since the fix, memberships are written only for the transaction's tenant.)
    await withTenant(a.id, (tx) => tx.membership.create({ data: { userId: user.id, organizationId: a.id, role: "MEMBER" } }), app);
    await withTenant(
      a.id,
      (tx) => tx.membership.create({ data: { userId: user.id, organizationId: b.id, role: "OWNER" } }),
      app,
    ).catch(() => undefined);
    // Observed: an OWNER membership of B, which requireMembership(b.slug) returns.
    expect(await findMembership(app, user.id, b.slug)).toBeNull();
  });
});
