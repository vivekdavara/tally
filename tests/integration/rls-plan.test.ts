// DESIGN.md says the policy's expression is written inline so the planner treats it as a constant and can
// use the (organization_id, ...) indexes. With sequential scans disabled, the plan for an unfiltered query
// under RLS must be an index scan; if the policy's condition couldn't use an index (say it called a
// volatile function per row), Postgres would still have to scan the table.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

let app: Db;
let orgId: string;

beforeAll(async () => {
  app = appDb({ max: 1 });
  const org = await app.organization.create({ data: { name: "Plan", slug: `plan-${unique()}` } });
  orgId = org.id;
});

afterAll(async () => {
  await app.$disconnect();
});

async function planFor(table: string): Promise<string> {
  return withTenant(
    orgId,
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (COSTS OFF) SELECT * FROM ${table}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    },
    app,
  );
}

describe("the tenant policy", () => {
  it.each(["customers", "invoices", "invoice_lines"])("lets the planner use an organization_id index on %s", async (table) => {
    const plan = await planFor(table);
    // e.g. "Index Scan using customers_organization_id_email_key on customers" (or a bitmap scan), with the
    // policy's own expression as the index condition.
    expect(plan).toMatch(new RegExp(`(Index|Index Only|Bitmap Index) Scan (using|on) ${table}_organization_id_\\w+`));
    expect(plan).toMatch(/Index Cond: \(organization_id = \(NULLIF\(current_setting\('app\.organization_id'/);
    expect(plan).not.toMatch(/Seq Scan/);
  });
});
