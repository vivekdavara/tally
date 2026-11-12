// WHAT'S WRONG: migration 20261112151800_invoicing grants tally_app
//   SELECT, INSERT ("organization_id", "last_number"), UPDATE ("last_number") ON invoice_counters,
// so any SQL run through withTenant (not just invoices_guard's upsert) can move the counter. Bumping it, or
// seeding a counter row before the first finalization, makes the next finalized invoice skip numbers (lowering
// it would make later finalizations collide on invoices_organization_id_number_key -- inferred, not tested).
// WHY IT MATTERS: DESIGN.md says "the numbers that customers see have no gaps", and the migration enforces the
// life cycle "for every writer" (any tally_app SQL), but the counter the trigger relies on is itself writable
// by that same role.
// The role check doesn't flag it either (FORBIDDEN lists only DELETE on invoice_counters).
// SUGGESTED FIX: the role check refuses SECURITY DEFINER functions tally_app can execute, so a definer function
// is out. Either (a) a BEFORE INSERT OR UPDATE trigger on invoice_counters that refuses unless
// pg_trigger_depth() > 1 (i.e. the write comes from inside invoices_guard; tally_app can't add triggers of its
// own) and NEW.last_number = coalesce(OLD.last_number, 0) + 1, or (b) drop the writable state: under a lock on
// the counter/organization row, take coalesce(max(number), 0) + 1 over the organization's invoices. Add the
// INSERT/UPDATE privileges to FORBIDDEN if (b).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import { appDb, unique } from "../helpers";

let app: Db;
beforeAll(() => {
  app = appDb({ max: 2 });
});
afterAll(async () => {
  await app.$disconnect();
});

const value = <T,>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
};

async function newOrg() {
  const org = await app.organization.create({ data: { name: "Ctr", slug: `ctr-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const customerId = value(await run((tx) => createCustomer(tx, { name: "C", email: `c-${unique()}@example.com`, address: null })));
  const draft = () =>
    run(async (tx) => {
      const id = value(await createDraft(tx, { customerId, currency: "USD", memo: null }));
      value(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor: 100n, taxRate: 0n }));
      return id;
    });
  return { id: org.id, run, draft };
}

describe("invoice_counters is writable by the application role", () => {
  it("a tally_app UPDATE of the counter makes the next number skip (a gap)", async () => {
    const org = await newOrg();
    const first = await org.draft();
    expect(value(await org.run((tx) => finalize(tx, first, 30)))).toBe(1);
    // Any code holding a TenantTx can do this; nothing refuses it.
    // (Adapted after the fix: the write is now refused by invoice_counters_guard, so the setup expects that.)
    await expect(org.run((tx) => tx.$executeRaw`UPDATE invoice_counters SET last_number = last_number + 41`)).rejects.toThrow(/TL010/);
    const second = await org.draft();
    // Gapless numbering requires 2.
    expect(value(await org.run((tx) => finalize(tx, second, 30)))).toBe(2);
  });

  it("a tally_app INSERT of a counter row before the first finalization makes the first invoice not number 1", async () => {
    const org = await newOrg();
    await expect(
      org.run((tx) => tx.$executeRaw`INSERT INTO invoice_counters (organization_id, last_number) VALUES (${org.id}::uuid, 1000)`),
    ).rejects.toThrow(/TL010/);
    const first = await org.draft();
    expect(value(await org.run((tx) => finalize(tx, first, 30)))).toBe(1);
  });
});
