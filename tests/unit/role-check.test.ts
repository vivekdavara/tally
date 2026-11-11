import { describe, expect, it } from "vitest";
import { roleProblems, type RoleFacts } from "@/server/db/role-check";

const safe: RoleFacts = {
  role: "tally_app",
  superuser: false,
  bypassRls: false,
  ownedTenantTables: [],
  unprotectedTenantTables: [],
};

describe("roleProblems", () => {
  it("passes a role that row-level security binds", () => {
    expect(roleProblems(safe)).toEqual([]);
  });

  it.each<[string, Partial<RoleFacts>, RegExp]>([
    ["a superuser", { superuser: true }, /superuser/],
    ["a BYPASSRLS role", { bypassRls: true }, /BYPASSRLS/],
    ["an owner of a tenant table", { ownedTenantTables: ["customers"] }, /owns or can become the owner of customers/],
    ["tables without forced RLS", { unprotectedTenantTables: ["invoices"] }, /not enabled and forced on invoices/],
  ])("refuses %s", (_, change, message) => {
    const problems = roleProblems({ ...safe, ...change });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(message);
  });

  it("reports every problem at once", () => {
    expect(roleProblems({ ...safe, superuser: true, bypassRls: true, ownedTenantTables: ["customers"] })).toHaveLength(3);
  });
});
