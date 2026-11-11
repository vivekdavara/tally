import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { APP_TABLES, assertSafeAppRole, readRoleFacts, roleProblems, type RoleFacts } from "@/server/db/role-check";
import { adminDb, appDb, ownerDb } from "../helpers";

let app: Db;
let owner: Db;
let admin: Db;

beforeAll(() => {
  app = appDb({ max: 1 });
  owner = ownerDb({ max: 1 });
  admin = adminDb({ max: 1 });
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), owner.$disconnect(), admin.$disconnect()]);
});

/**
 * The facts as `role` sees them after `setup`, read inside a superuser transaction that is rolled back:
 * roles created and grants made there never exist for anyone else.
 */
async function factsAfter(setup: string[], role: string): Promise<RoleFacts> {
  return admin
    .$transaction(async (tx) => {
      for (const statement of setup) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      const facts = await readRoleFacts(tx);
      throw Object.assign(new Error("rollback"), { facts });
    })
    .catch((e: { facts?: RoleFacts }) => {
      if (!e.facts) throw e;
      return e.facts;
    });
}

describe("the role check against Postgres", () => {
  it("reads tally_app as bound by row-level security, with exactly the migration's policies and grants", async () => {
    expect(await readRoleFacts(app)).toEqual({
      role: "tally_app",
      superuser: false,
      bypassRls: false,
      privilegedRoles: [],
      ownedTables: [],
      unprotectedTables: [],
      policyProblems: [],
      forbiddenPrivileges: [],
      presetTenant: null,
    });
    await expect(assertSafeAppRole(app)).resolves.toBeUndefined();
  });

  it("refuses the owner role, which could switch row-level security off", async () => {
    await expect(assertSafeAppRole(owner)).rejects.toThrow(
      /refusing to serve: tally_owner owns or can become the owner of customers, invoice_lines, invoices, memberships, organizations, users/,
    );
  });

  it("refuses a superuser", async () => {
    const facts = await readRoleFacts(admin);
    expect(facts.superuser).toBe(true);
    expect(roleProblems(facts).join("; ")).toMatch(/is a superuser/);
  });

  it("refuses a role with BYPASSRLS", async () => {
    const facts = await factsAfter(["CREATE ROLE tally_check_bypass NOLOGIN BYPASSRLS"], "tally_check_bypass");
    expect(facts).toMatchObject({ role: "tally_check_bypass", bypassRls: true });
  });

  it("refuses tally_app once it is a member of a superuser role or the owner role", async () => {
    const su = await factsAfter(["CREATE ROLE tally_check_su NOLOGIN SUPERUSER", "GRANT tally_check_su TO tally_app"], "tally_app");
    expect(su.privilegedRoles).toEqual(["tally_check_su"]);
    const ownerMember = await factsAfter(["GRANT tally_owner TO tally_app"], "tally_app");
    expect(ownerMember.ownedTables).toEqual([...APP_TABLES].sort());
  });

  it("sees a table whose row-level security was disabled, or no longer forced", async () => {
    for (const change of ["DISABLE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY"]) {
      const facts = await factsAfter([`ALTER TABLE invoices ${change}`], "tally_app");
      expect(facts.unprotectedTables, change).toEqual(["invoices"]);
    }
    expect((await readRoleFacts(app)).unprotectedTables).toEqual([]);
  });

  it("sees a policy that was changed, dropped or added", async () => {
    const changed = await factsAfter(
      ["ALTER POLICY tenant_isolation ON invoices USING (true)"],
      "tally_app",
    );
    expect(changed.policyProblems).toEqual(["policy tenant_isolation on invoices differs from the migration's"]);
    const dropped = await factsAfter(["DROP POLICY memberships_insert ON memberships"], "tally_app");
    expect(dropped.policyProblems).toEqual(["policy memberships_insert on memberships is missing"]);
    const restrictive = await factsAfter(
      ["CREATE POLICY extra ON customers AS RESTRICTIVE USING (true)"],
      "tally_app",
    );
    expect(restrictive.policyProblems).toContain("unexpected policy extra on customers");
  });

  it("sees privileges the app role must not hold", async () => {
    const facts = await factsAfter(
      ["GRANT ALL ON customers TO tally_app", "GRANT DELETE ON users TO tally_app"],
      "tally_app",
    );
    expect(facts.forbiddenPrivileges).toEqual(
      expect.arrayContaining([
        "TRUNCATE on customers",
        "REFERENCES on customers",
        "TRIGGER on customers",
        "INSERT (id) on customers",
        "UPDATE (organization_id) on customers",
        "DELETE on users",
      ]),
    );
  });

  it("sees a connection that starts with a tenant already set", async () => {
    // As if DATABASE_URL carried options=-c app.organization_id=..., or the role had it as a default.
    const tenant = crypto.randomUUID();
    const url = `${process.env.TEST_DATABASE_URL}?options=${encodeURIComponent(`-c app.organization_id=${tenant}`)}`;
    const preset = createDb(url, { max: 1 });
    try {
      expect((await readRoleFacts(preset)).presetTenant).toBe(tenant);
      await expect(assertSafeAppRole(preset)).rejects.toThrow(/already set/);
    } finally {
      await preset.$disconnect();
    }
  });
});
