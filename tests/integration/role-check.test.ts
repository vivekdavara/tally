import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { assertSafeAppRole, readRoleFacts } from "@/server/db/role-check";
import { appDb, ownerDb } from "../helpers";

let app: Db;
let owner: Db;

beforeAll(() => {
  app = appDb({ max: 1 });
  owner = ownerDb({ max: 1 });
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), owner.$disconnect()]);
});

describe("the role check against Postgres", () => {
  it("reads tally_app as bound by row-level security", async () => {
    expect(await readRoleFacts(app)).toEqual({
      role: "tally_app",
      superuser: false,
      bypassRls: false,
      ownedTenantTables: [],
      unprotectedTenantTables: [],
    });
    await expect(assertSafeAppRole(app)).resolves.toBeUndefined();
  });

  it("refuses the owner role, which could switch row-level security off", async () => {
    await expect(assertSafeAppRole(owner)).rejects.toThrow(
      /refusing to serve: tally_owner owns or can become the owner of customers, invoice_lines, invoices/,
    );
  });

  it("sees a table whose row-level security was disabled", async () => {
    // In a transaction that rolls back: the owner disables RLS, and the facts read inside it show the gap.
    const facts = await owner
      .$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY`;
        const inside = await readRoleFacts(tx);
        throw Object.assign(new Error("rollback"), { inside });
      })
      .catch((e: { inside?: unknown }) => e.inside);
    expect(facts).toMatchObject({ unprotectedTenantTables: ["invoices"] });
    expect((await readRoleFacts(app)).unprotectedTenantTables).toEqual([]);
  });
});
