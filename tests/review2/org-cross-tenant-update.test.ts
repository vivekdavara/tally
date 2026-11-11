// REVIEW 2 FINDING: least_privilege grants tally_app UPDATE (name, slug) ON organizations, and organizations
// has no row-level security, so inside tenant A's withTenant one ordinary Prisma call renames organization B
// or changes its slug (B's members' URLs stop resolving; A can then take B's old slug). DESIGN.md's promise
// is that no request on behalf of one organization can change another's data "even when the application code
// has a bug"; this is the same single-call shape as round 1's membership finding, which 6bb1872 closed only
// for memberships. Nothing in the app updates organizations yet, so a policy costs nothing today.
//
// Suggested fix: ENABLE + FORCE RLS on organizations with FOR SELECT USING (true), FOR INSERT WITH CHECK
// (true) (sign-up), FOR UPDATE USING/WITH CHECK (id = NULLIF(current_setting('app.organization_id', true),
// '')::uuid); add them to EXPECTED_POLICIES and organizations to RLS_TABLES. (Or drop the UPDATE grant
// until D4 needs it.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { findMembership } from "@/server/orgs/memberships";
import { appDb, unique } from "../helpers";

let app: Db;

beforeAll(() => {
  app = appDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
});

describe("organizations from inside another tenant's transaction", () => {
  it("can't be renamed or have their slug changed", async () => {
    const s = unique();
    const a = await app.organization.create({ data: { name: `a ${s}`, slug: `a-${s}` } });
    const b = await app.organization.create({ data: { name: `b ${s}`, slug: `b-${s}` } });
    const user = await app.user.create({ data: { email: `b-${s}@example.com`, name: "B", passwordHash: "x" } });
    await withTenant(b.id, (tx) => tx.membership.create({ data: { organizationId: b.id, userId: user.id, role: "OWNER" } }), app);

    // As tenant A, with B's id (say, from a form field).
    const outcome = await withTenant(
      a.id,
      (tx) => tx.organization.update({ where: { id: b.id }, data: { name: "Pwned", slug: `pwned-${s}` } }),
      app,
    ).then(
      () => "updated",
      (e: Error) => e.message,
    );

    const after = await app.organization.findUniqueOrThrow({ where: { id: b.id } });
    // Observed: outcome "updated", B is now named "Pwned", and its owner's link to /o/b-... is a 404.
    expect({ name: after.name, slug: after.slug }).toEqual({ name: `b ${s}`, slug: `b-${s}` });
    expect(await findMembership(app, user.id, `b-${s}`)).not.toBeNull();
    expect(outcome).not.toBe("updated");
  });
});
