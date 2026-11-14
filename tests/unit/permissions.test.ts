// The roles table of DESIGN.md ("Roles"), cell by cell, against src/server/orgs/permissions.ts. If either changes,
// this test says which cell.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allows, PERMISSIONS, permissionToRemove, permissionToSetRole, type Permission } from "@/server/orgs/permissions";

// DESIGN.md's rows, and the permissions each row stands for.
const ROWS: { row: string; permissions: Permission[]; owner: boolean; admin: boolean; member: boolean }[] = [
  { row: "View customers and invoices", permissions: ["view"], owner: true, admin: true, member: true },
  { row: "Create and edit customers, draft invoices", permissions: ["edit-customers", "edit-drafts"], owner: true, admin: true, member: true },
  { row: "Finalize, void, mark paid, create payment links", permissions: ["finalize", "void", "mark-paid", "collect-payment"], owner: true, admin: true, member: false },
  { row: "Invite and remove members, change roles (below owner)", permissions: ["manage-members"], owner: true, admin: true, member: false },
  { row: "Make, change or remove an owner", permissions: ["manage-owners"], owner: true, admin: false, member: false },
];

describe("the roles table", () => {
  for (const r of ROWS) {
    for (const p of r.permissions) {
      it(`${p}: owner ${r.owner}, admin ${r.admin}, member ${r.member}`, () => {
        expect([allows("OWNER", p), allows("ADMIN", p), allows("MEMBER", p)]).toEqual([r.owner, r.admin, r.member]);
      });
    }
  }

  it("covers every permission", () => {
    expect(ROWS.flatMap((r) => r.permissions).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  it("is the table DESIGN.md shows", () => {
    const design = readFileSync(join(import.meta.dirname, "..", "..", "DESIGN.md"), "utf8");
    const yes = (b: boolean) => (b ? "yes" : "no");
    for (const r of ROWS) {
      expect(design).toContain(`| ${r.row} | ${yes(r.owner)} | ${yes(r.admin)} | ${yes(r.member)} |`);
    }
  });

  it("needs an owner for anything that makes or unmakes an owner", () => {
    expect(permissionToSetRole(null, "OWNER")).toBe("manage-owners");
    expect(permissionToSetRole("OWNER", "ADMIN")).toBe("manage-owners");
    expect(permissionToSetRole("OWNER", "OWNER")).toBe("manage-owners");
    expect(permissionToSetRole(null, "ADMIN")).toBe("manage-members");
    expect(permissionToSetRole("MEMBER", "ADMIN")).toBe("manage-members");
    expect(permissionToSetRole("ADMIN", "MEMBER")).toBe("manage-members");
    expect(permissionToRemove("OWNER")).toBe("manage-owners");
    expect(permissionToRemove("ADMIN")).toBe("manage-members");
    expect(permissionToRemove("MEMBER")).toBe("manage-members");
  });
});
