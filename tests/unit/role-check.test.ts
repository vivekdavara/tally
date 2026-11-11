import { describe, expect, it } from "vitest";
import { roleProblems, type RoleFacts } from "@/server/db/role-check";

const safe: RoleFacts = {
  role: "tally_app",
  superuser: false,
  bypassRls: false,
  privilegedRoles: [],
  ownedTables: [],
  unprotectedTables: [],
  policyProblems: [],
  forbiddenPrivileges: [],
  presetTenant: null,
};

describe("roleProblems", () => {
  it("passes a role that row-level security binds", () => {
    expect(roleProblems(safe)).toEqual([]);
  });

  it.each<[string, Partial<RoleFacts>, RegExp]>([
    ["a superuser", { superuser: true }, /superuser/],
    ["a BYPASSRLS role", { bypassRls: true }, /BYPASSRLS/],
    ["a member of a privileged role", { privilegedRoles: ["admins"] }, /can SET ROLE to admins/],
    ["an owner of an application table", { ownedTables: ["customers"] }, /owns or can become the owner of customers/],
    ["tables without forced RLS", { unprotectedTables: ["invoices"] }, /not enabled and forced on invoices/],
    ["a changed policy", { policyProblems: ["unexpected policy open on customers"] }, /unexpected policy open on customers/],
    ["a forbidden privilege", { forbiddenPrivileges: ["TRUNCATE on customers"] }, /must not: TRUNCATE on customers/],
    ["a tenant set before any transaction", { presetTenant: "0b6c…" }, /already set/],
  ])("refuses %s", (_, change, message) => {
    const problems = roleProblems({ ...safe, ...change });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });

  it("reports every problem at once", () => {
    expect(roleProblems({ ...safe, superuser: true, bypassRls: true, ownedTables: ["customers"] })).toHaveLength(3);
  });
});
