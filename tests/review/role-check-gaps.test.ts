// REVIEW FINDING: assertSafeAppRole() passes configurations in which row-level security no longer isolates
// tenants. It reads rolsuper, rolbypassrls, ownership and the two relrowsecurity flags, and nothing else:
//
// 1. Policy content. A second permissive policy USING (true) (or an edited tenant_isolation) makes every row
//    visible to everyone, and the check still reports no problem: it never reads pg_policy.
// 2. TRUNCATE. The privilege isn't subject to row security (TRUNCATE ignores policies), so a GRANT ALL in a
//    future migration lets the app role wipe every tenant's rows; the check doesn't look at privileges.
// 3. A default tenant. A connection that starts with app.organization_id already set (DATABASE_URL
//    ?options=-c app.organization_id=..., or ALTER ROLE/DATABASE ... SET) sees that tenant's rows in every
//    query outside withTenant, and after every withTenant ends; "no tenant sees no rows" is gone, and the
//    check passes.
//
// Suggested fix: also require (a) exactly one policy per tenant table, permissive, FOR ALL, whose qual and
// with_check equal the expected expression (compare pg_get_expr(polqual, polrelid)); (b) tally_app's table
// privileges to be exactly SELECT/INSERT/UPDATE/DELETE (has_table_privilege(..., 'TRUNCATE,REFERENCES,TRIGGER')
// false); (c) current_setting('app.organization_id', true) to be NULL or '' on a fresh connection.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { assertSafeAppRole, readRoleFacts, roleProblems } from "@/server/db/role-check";
import { withTenant } from "@/server/db/tenant";
import { appDb, appUrl, ownerDb, unique } from "../helpers";

let app: Db;
let owner: Db;
let org: { id: string };

beforeAll(async () => {
  app = appDb({ max: 2 });
  owner = ownerDb({ max: 1 });
  const s = unique();
  org = await app.organization.create({ data: { name: `gap ${s}`, slug: `gap-${s}` } });
  await withTenant(
    org.id,
    (tx) => tx.customer.create({ data: { organizationId: org.id, name: "c", email: `c-${s}@example.com` } }),
    app,
  );
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), owner.$disconnect()]);
});

describe("the role check", () => {
  it("notices a policy that lets every row through", async () => {
    // In a transaction that rolls back, so nothing else ever sees the policy.
    const result = await owner
      .$transaction(async (tx) => {
        await tx.$executeRaw`CREATE POLICY review_open ON customers USING (true)`;
        // FORCE applies to the owner too, so this count is what the policy now lets anyone see with no tenant.
        const n = (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM customers`)[0]?.n;
        const facts = await readRoleFacts(tx);
        throw Object.assign(new Error("rollback"), { n, facts });
      })
      .catch((e: { n: bigint; facts: Awaited<ReturnType<typeof readRoleFacts>> }) => e);
    expect(result.n).toBeGreaterThan(0n); // the policy really leaks
    // The same facts as tally_app would read (it isn't the owner): Observed: [] (no problem found).
    expect(roleProblems({ ...result.facts, role: "tally_app", ownedTables: [] })).not.toEqual([]);
  });

  it("notices that the app role can TRUNCATE a tenant table", async () => {
    await owner.$executeRaw`GRANT TRUNCATE ON customers TO tally_app`;
    try {
      // Observed: resolves; the app role could now empty customers for every tenant at once.
      await expect(assertSafeAppRole(app)).rejects.toThrow();
    } finally {
      await owner.$executeRaw`REVOKE TRUNCATE ON customers FROM tally_app`;
    }
  });

  it("notices a connection that starts with a tenant already set", async () => {
    const url = new URL(appUrl());
    url.searchParams.set("options", `-c app.organization_id=${org.id}`);
    const preset = createDb(url.toString(), { max: 1 });
    try {
      const outside = await preset.customer.count();
      expect(outside).toBe(1); // a query with no withTenant sees that tenant's rows
      // Observed: resolves.
      await expect(assertSafeAppRole(preset)).rejects.toThrow();
    } finally {
      await preset.$disconnect();
    }
  });
});
