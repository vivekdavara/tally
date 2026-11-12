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
      sessionUser: null,
      memberOfRoles: [],
      definerFunctions: [],
      ownedTables: [],
      unprotectedTables: [],
      policyProblems: [],
      forbiddenPrivileges: [],
      presetTenant: null,
      creationPrivileges: [],
      missingTriggers: [],
      replicationRole: null,
    });
    await expect(assertSafeAppRole(app)).resolves.toBeUndefined();
  });

  it("refuses the owner role, which could switch row-level security off", async () => {
    await expect(assertSafeAppRole(owner)).rejects.toThrow(
      /refusing to serve: .*tally_owner owns or can become the owner of customers, invoice_counters, invoice_lines, invoices, memberships, organizations, users/,
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
    expect(su.memberOfRoles).toEqual(["tally_check_su"]);
    const ownerMember = await factsAfter(["GRANT tally_owner TO tally_app"], "tally_app");
    expect(ownerMember.ownedTables).toEqual([...APP_TABLES].sort());
    // tally_owner owns the database, which makes it (and so its members) pg_database_owner too.
    expect(ownerMember.memberOfRoles).toEqual(["pg_database_owner", "tally_owner"]);
    const bypass = await factsAfter(["CREATE ROLE tally_check_b NOLOGIN BYPASSRLS", "GRANT tally_check_b TO tally_app"], "tally_app");
    expect(bypass.memberOfRoles).toEqual(["tally_check_b"]);
  });

  it("sees a table whose row-level security was disabled, or no longer forced", async () => {
    for (const change of ["DISABLE ROW LEVEL SECURITY", "NO FORCE ROW LEVEL SECURITY"]) {
      const facts = await factsAfter([`ALTER TABLE invoices ${change}`], "tally_app");
      expect(facts.unprotectedTables, change).toEqual(["invoices"]);
    }
    const memberships = await factsAfter(["ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY"], "tally_app");
    expect(memberships.unprotectedTables).toEqual(["memberships"]);
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
    // The migration's own policy, recreated as RESTRICTIVE with the same expressions: only the permissive
    // check sees it (round 2: that check could be removed with every test green).
    const condition = "organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid";
    const sameButRestrictive = await factsAfter(
      [
        "DROP POLICY tenant_isolation ON customers",
        `CREATE POLICY tenant_isolation ON customers AS RESTRICTIVE USING (${condition}) WITH CHECK (${condition})`,
      ],
      "tally_app",
    );
    expect(sameButRestrictive.policyProblems).toEqual([
      "a policy is restrictive or limited to particular roles, unlike the migration's",
    ]);
    // Only WITH CHECK loosened (cross-tenant writes, reads unchanged).
    const looseCheck = await factsAfter(["ALTER POLICY tenant_isolation ON invoices WITH CHECK (true)"], "tally_app");
    expect(looseCheck.policyProblems).toEqual(["policy tenant_isolation on invoices differs from the migration's"]);
  });

  it("sees privileges the app role must not hold", async () => {
    const facts = await factsAfter(
      [
        "GRANT ALL ON customers TO tally_app",
        "GRANT DELETE ON users, organizations TO tally_app",
        "GRANT UPDATE (user_id) ON memberships TO tally_app",
        "GRANT UPDATE (name) ON users, organizations TO tally_app",
      ],
      "tally_app",
    );
    expect(facts.forbiddenPrivileges).toEqual(
      expect.arrayContaining([
        "TRUNCATE on customers",
        "REFERENCES on customers",
        "TRIGGER on customers",
        "INSERT (id) on customers",
        "UPDATE (organization_id) on customers",
        "UPDATE (id) on customers",
        "DELETE on users",
        "DELETE on organizations",
        "UPDATE (user_id) on memberships",
        "UPDATE (any column) on users",
        "UPDATE (any column) on organizations",
      ]),
    );
  });

  it.each([
    // Day 2 (migrations/*_invoicing): the trigger writes these, never the application.
    ["INSERT", "number"],
    ["UPDATE", "number"],
    ["INSERT", "issued_at"],
    ["UPDATE", "issued_at"],
    ["INSERT", "subtotal_minor"],
    ["UPDATE", "subtotal_minor"],
    ["INSERT", "tax_minor"],
    ["UPDATE", "tax_minor"],
    ["INSERT", "total_minor"],
    ["UPDATE", "total_minor"],
    ["UPDATE", "currency"],
    ["INSERT", "bill_to_name"],
    ["UPDATE", "bill_to_name"],
    ["UPDATE", "bill_to_email"],
    ["UPDATE", "bill_to_address"],
  ])("sees %s (%s) on invoices, one grant at a time", async (privilege, column) => {
    const facts = await factsAfter([`GRANT ${privilege} (${column}) ON invoices TO tally_app`], "tally_app");
    expect(facts.forbiddenPrivileges).toEqual([`${privilege} (${column}) on invoices`]);
  });

  it("sees DELETE or an organization_id change on invoice_counters", async () => {
    const facts = await factsAfter(["GRANT DELETE, UPDATE (organization_id) ON invoice_counters TO tally_app"], "tally_app");
    expect(facts.forbiddenPrivileges).toEqual(["DELETE on invoice_counters", "UPDATE (organization_id) on invoice_counters"]);
  });

  it("sees a policy added to invoice_counters", async () => {
    const facts = await factsAfter(["CREATE POLICY wide_open ON invoice_counters USING (true)"], "tally_app");
    expect(facts.policyProblems).toEqual(["unexpected policy wide_open on invoice_counters"]);
  });

  it.each([
    ["invoices", "invoices_guard"],
    ["invoice_lines", "invoice_lines_guard"],
    ["invoice_counters", "invoice_counters_guard"],
  ])("sees the %s trigger %s disabled or dropped", async (table, trigger) => {
    expect((await factsAfter([`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`], "tally_app")).missingTriggers).toEqual([`${table}.${trigger}`]);
    expect((await factsAfter([`DROP TRIGGER ${trigger} ON ${table}`], "tally_app")).missingTriggers).toEqual([`${table}.${trigger}`]);
    // Set to fire only under session_replication_role = replica: not for ordinary sessions.
    expect((await factsAfter([`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`], "tally_app")).missingTriggers).toEqual([`${table}.${trigger}`]);
  });

  it("sees a role that may create objects in the database or schema public", async () => {
    const facts = await factsAfter(
      ["GRANT CREATE ON SCHEMA public TO tally_app", "DO $$ BEGIN EXECUTE format('GRANT CREATE, TEMP ON DATABASE %I TO tally_app', current_database()); END $$"],
      "tally_app",
    );
    expect(facts.creationPrivileges).toEqual(["CREATE on schema public", "CREATE on the database", "TEMP on the database"]);
    expect(roleProblems(facts).join("; ")).toMatch(/may create objects/);
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
