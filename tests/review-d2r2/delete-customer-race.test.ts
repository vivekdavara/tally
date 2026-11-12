// Adapted for 8c49a8e (fixed after the reviewed commit): refusals() takes the foreign-key map the actions pass.
// WHAT'S WRONG: deleteCustomer (src/server/invoices/service.ts) counts the customer's invoices and then deletes
// it, relying on "the invoices' foreign key refuses otherwise" -- but nothing maps that refusal. When a draft for
// the customer is created concurrently (READ COMMITTED: the count doesn't see the other transaction's
// uncommitted invoice; the DELETE then waits on that transaction's key-share lock and, once it commits, the
// foreign key refuses), the FK violation (23503, P2003) escapes as an exception: deleteCustomerAction
// (src/app/o/[slug]/actions.ts) calls run(...) without refusals(), and refusals() wouldn't map 23503 anyway
// (TRIGGER_REASONS / UNIQUE_REASONS only). It's round 1's finding 5 (a database refusal surfacing as a 500)
// for the other customer write. The mirror image fails the same way: createDraft counts the customer, a
// concurrent deleteCustomer commits, and the invoice insert's foreign key check refuses (P2003) -- a 500 from
// createDraftAction (also not wrapped in refusals) instead of "Choose a customer from the list." (second test).
// WHY IT MATTERS: the user sees a 500 instead of "This customer has invoices, so it can't be deleted."
// SUGGESTED FIX: lock the customer row first (SELECT ... FOR UPDATE: a concurrent createDraft's FK check then
// waits, and its count sees the committed invoice), or map the invoices -> customers foreign key's violation
// to "has-invoices" in refusals() by constraint name, and wrap deleteCustomerAction's run in refusals().
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { sqlState } from "@/server/db/errors";
import { createCustomer, createDraft, CUSTOMER_GONE, CUSTOMER_HAS_INVOICES, deleteCustomer, refusals } from "@/server/invoices/service";
import { adminDb, appDb, unique } from "../helpers";

let app: Db;
let admin: Db;
beforeAll(() => {
  app = appDb({ max: 3 });
  admin = adminDb({ max: 1 });
});
afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

const value = <T,>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
};

describe("deleting a customer while a draft for it is being created", () => {
  it("answers has-invoices, not an exception", async () => {
    const org = await app.organization.create({ data: { name: "Race", slug: `race-${unique()}` } });
    const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
    const customerId = value(await run((tx) => createCustomer(tx, { name: "C", email: `c-${unique()}@example.com`, address: null })));

    // Transaction 2: creates a draft for the customer and stays open until released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let created!: () => void;
    const draftCreated = new Promise<void>((resolve) => (created = resolve));
    const t2 = run(async (tx) => {
      value(await createDraft(tx, { customerId, currency: "USD", memo: null }));
      created();
      await held;
    });
    await draftCreated;

    // Transaction 1: the delete, as deleteCustomerAction would run it if it used refusals().
    const t1 = refusals(() => run((tx) => deleteCustomer(tx, customerId)), CUSTOMER_HAS_INVOICES).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: `${(error as { code?: string }).code} SQLSTATE ${sqlState(error)}` }),
    );
    // Wait until transaction 1 is blocked on transaction 2's lock, then let transaction 2 commit.
    for (let i = 0; i < 100; i++) {
      const [row] = await admin.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'tally_app' AND wait_event_type = 'Lock'`);
      if (row!.n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await t2;
    expect(await t1).toEqual({ result: { ok: false, reason: "has-invoices" } });
  });

  it("creating a draft for a customer being deleted answers no-customer, not an exception", async () => {
    const org = await app.organization.create({ data: { name: "Race2", slug: `race2-${unique()}` } });
    const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
    const customerId = value(await run((tx) => createCustomer(tx, { name: "C", email: `c-${unique()}@example.com`, address: null })));

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let deleted!: () => void;
    const customerDeleted = new Promise<void>((resolve) => (deleted = resolve));
    const t2 = run(async (tx) => {
      value(await deleteCustomer(tx, customerId));
      deleted();
      await held;
    });
    await customerDeleted;

    const t1 = refusals(() => run((tx) => createDraft(tx, { customerId, currency: "USD", memo: null })), CUSTOMER_GONE).then(
      (result) => ({ result }),
      (error: unknown) => ({ error: `${(error as { code?: string }).code} SQLSTATE ${sqlState(error)}` }),
    );
    for (let i = 0; i < 100; i++) {
      const [row] = await admin.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND usename = 'tally_app' AND wait_event_type = 'Lock'`);
      if (row!.n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    await t2;
    expect(await t1).toEqual({ result: { ok: false, reason: "no-customer" } });
  });
});
