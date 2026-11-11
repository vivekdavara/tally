// REVIEW 2 FINDINGS: configurations in which assertSafeAppRole() (91811f0) still passes although the
// application's connection is not bound by row-level security, or the app role holds a privilege that
// least_privilege took away. Every grant/role change is made in a transaction that rolls back.
//
// 1. A superuser (or tally_owner) session that only *sets* role tally_app: DATABASE_URL as the admin user
//    with ?options=-c role=tally_app (or ALTER ROLE ... SET role). current_user is tally_app, so every fact
//    the check reads is tally_app's, but the session can SET ROLE NONE (or RESET ROLE after a SET ROLE) and
//    is a superuser again; any raw SQL that does so bypasses RLS. The check never looks at session_user.
//    Suggested fix: also require session_user = current_user (or run roleProblems for session_user too).
// 2. UPDATE on users: least_privilege grants none (any tenant's code could otherwise change any user's
//    email or password_hash: an account takeover across organizations), but FORBIDDEN lists only id, so
//    GRANT UPDATE (email, password_hash) ON users passes the check. Suggested fix: forbid UPDATE on users
//    (every column), and, generally, compare the app role's column privileges with the exact expected set
//    (information_schema.column_privileges / aclexplode) instead of a deny-list.
// 3. A SECURITY DEFINER function owned by a role that bypasses RLS (a superuser here), executable by
//    tally_app (PUBLIC has EXECUTE by default): SELECT leak() reads every tenant's rows. The check doesn't
//    look at functions. Suggested fix: refuse any SECURITY DEFINER function in a schema the app can use
//    whose owner is a superuser, BYPASSRLS, or an owner of an RLS table, unless EXECUTE is revoked from
//    tally_app and PUBLIC.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { readRoleFacts, roleProblems, assertSafeAppRole } from "@/server/db/role-check";
import { withTenant } from "@/server/db/tenant";
import { adminDb, appDb, unique } from "../helpers";

let app: Db;
let admin: Db;

beforeAll(async () => {
  app = appDb({ max: 1 });
  admin = adminDb({ max: 1 });
  const s = unique();
  const org = await app.organization.create({ data: { name: `g2 ${s}`, slug: `g2-${s}` } });
  await withTenant(org.id, (tx) => tx.customer.create({ data: { organizationId: org.id, name: "c", email: `c-${s}@example.com` } }), app);
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), admin.$disconnect()]);
});

async function inRolledBack<T>(setup: string[], read: (tx: Parameters<Parameters<Db["$transaction"]>[0]>[0]) => Promise<T>): Promise<T> {
  return admin
    .$transaction(async (tx) => {
      for (const statement of setup) await tx.$executeRawUnsafe(statement);
      const value = await read(tx);
      throw Object.assign(new Error("rollback"), { value });
    })
    .catch((e: { value?: T }) => {
      if (!("value" in e)) throw e;
      return e.value as T;
    });
}

describe("the role check, round 2", () => {
  it("refuses a superuser session that merely set role tally_app at connect", async () => {
    const url = new URL(process.env.TEST_ADMIN_DATABASE_URL!);
    url.searchParams.set("options", "-c role=tally_app");
    const disguised = createDb(url.toString(), { max: 1 });
    try {
      const outcome = await assertSafeAppRole(disguised).then(
        () => "passed",
        () => "refused",
      );
      // The escape: one raw statement and RLS is gone for this session.
      const escaped = await disguised.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL ROLE NONE");
        return (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM customers`)[0]!.n;
      });
      expect(escaped).toBeGreaterThan(0n); // every tenant's customers, no tenant set
      // Observed: "passed".
      expect(outcome).toBe("refused");
    } finally {
      await disguised.$disconnect();
    }
  });

  it("refuses UPDATE on users (email, password_hash)", async () => {
    const problems = await inRolledBack(["GRANT UPDATE (email, password_hash) ON users TO tally_app", "SET LOCAL ROLE tally_app"], async (tx) =>
      roleProblems(await readRoleFacts(tx)),
    );
    // Observed: [] (no problem).
    expect(problems).not.toEqual([]);
  });

  it("refuses a SECURITY DEFINER function, owned by a role that bypasses RLS, that the app may execute", async () => {
    const out = await inRolledBack(
      [
        "CREATE FUNCTION public.review2_leak() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.customers'",
        "SET LOCAL ROLE tally_app",
      ],
      async (tx) => ({
        problems: roleProblems(await readRoleFacts(tx)),
        leaked: (await tx.$queryRaw<{ n: bigint }[]>`SELECT public.review2_leak() AS n`)[0]!.n,
      }),
    );
    expect(out.leaked).toBeGreaterThan(0n); // tally_app, no tenant, reads every tenant's customers
    // Observed: problems [].
    expect(out.problems).not.toEqual([]);
  });
});

describe("the role check, round 2: privileges reachable by SET ROLE", () => {
  // 4. tally_app is NOINHERIT (db-setup.sh), so has_table_privilege() leaves out the privileges of roles it is
  //    a member of: it holds them only after SET ROLE. The check counts SET ROLE for superuser/BYPASSRLS
  //    roles and for owners (pg_has_role 'MEMBER'), but not for the FORBIDDEN privileges: a membership in
  //    pg_write_all_data (or in any role granted DELETE on users / UPDATE (id)) passes, and one SET ROLE away
  //    is DELETE FROM organizations, which cascades through another tenant's rows without row security.
  //    Suggested fix: evaluate FORBIDDEN for every role tally_app is a MEMBER of (pg_has_role), not only for
  //    tally_app itself; or refuse any role membership at all.
  it("refuses tally_app as a member of pg_write_all_data", async () => {
    const out = await inRolledBack(["GRANT pg_write_all_data TO tally_app"], async (tx) => {
      const [row] = await tx.$queryRaw<{ member: boolean; via: boolean }[]>`
        SELECT pg_has_role('tally_app', 'pg_write_all_data', 'MEMBER') AS member,
               has_table_privilege('pg_write_all_data', 'public.organizations', 'DELETE') AS via`;
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      return { ...row, problems: roleProblems(await readRoleFacts(tx)) };
    });
    expect({ member: out.member, via: out.via }).toEqual({ member: true, via: true });
    // Observed: problems [].
    expect(out.problems).not.toEqual([]);
  });
});
