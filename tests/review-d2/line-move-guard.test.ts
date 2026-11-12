// WHAT'S WRONG: invoice_lines_guard (migration 20261112151800_invoicing) checks and locks only the invoice the
// line points to AFTER the write (`line := NEW` for UPDATE). If a line's invoice_id can be updated, a line can
// be moved OUT of an OPEN/PAID invoice into a draft: the final invoice's lines change and its stored totals no
// longer add up (getInvoice then throws TotalsMismatchError forever). Today tally_app has no UPDATE (invoice_id)
// grant, so the trigger relies on that grant being absent -- but the startup role check (FORBIDDEN in
// src/server/db/role-check.ts) doesn't list UPDATE (invoice_id) on invoice_lines, so the app starts happily with
// the one grant that defeats the trigger. (Latent today: it needs that grant to be added, e.g. by a later
// migration that grants UPDATE on a list of columns.)
// WHY IT MATTERS: "a final invoice's lines can't change" is meant to be enforced for every writer, and the role
// check is meant to refuse any grant that switches a guarantee off.
// SUGGESTED FIX: in invoice_lines_guard, for UPDATE also lock and check OLD's invoice (or refuse
// NEW.invoice_id IS DISTINCT FROM OLD.invoice_id outright), and add
// { table: "invoice_lines", privilege: "UPDATE", column: "invoice_id" } to FORBIDDEN.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { readRoleFacts } from "@/server/db/role-check";
import { adminDb, unique } from "../helpers";

let admin: Db;
beforeAll(() => {
  admin = adminDb({ max: 1 });
});
afterAll(async () => {
  await admin.$disconnect();
});

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** Runs fn inside a superuser transaction that is always rolled back; returns fn's value or its error. */
async function rolledBack<T>(fn: (tx: Tx) => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return admin
    .$transaction(async (tx) => {
      let out: { value?: T; error?: unknown };
      try {
        out = { value: await fn(tx) };
      } catch (error) {
        out = { error };
      }
      throw Object.assign(new Error("rollback"), { out });
    })
    .catch((e: { out?: { value?: T; error?: unknown } }) => {
      if (!e.out) throw e;
      return e.out;
    });
}

describe("moving a line between invoices", () => {
  it("the role check refuses UPDATE (invoice_id) on invoice_lines", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe("GRANT UPDATE (invoice_id) ON invoice_lines TO tally_app");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      return (await readRoleFacts(tx)).forbiddenPrivileges;
    });
    expect(error).toBeUndefined();
    expect(value!.join("; ")).toMatch(/invoice_id.*invoice_lines/);
  });

  it("invoice_lines_guard refuses moving a line out of an OPEN invoice", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      const [org] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO organizations (name, slug) VALUES ('Mv', 'mv-${unique()}') RETURNING id::text`);
      const [cust] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO customers (organization_id, name, email) VALUES ('${org!.id}', 'C', 'c-${unique()}@example.com') RETURNING id::text`);
      const mk = async () =>
        (await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO invoices (organization_id, customer_id, currency) VALUES ('${org!.id}', '${cust!.id}', 'USD') RETURNING id::text`))[0]!.id;
      const open = await mk();
      const draft = await mk();
      await tx.$executeRawUnsafe(
        `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor)
         VALUES ('${org!.id}', '${open}', 1, 'A', 1, 100), ('${org!.id}', '${open}', 2, 'B', 1, 5000)`);
      await tx.$executeRawUnsafe(
        `UPDATE invoices SET status = 'OPEN', due_on = current_date + 30 WHERE id = '${open}'`);
      const [moved] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id::text FROM invoice_lines WHERE invoice_id = '${open}' AND position = 2`);

      await tx.$executeRawUnsafe("GRANT UPDATE (invoice_id) ON invoice_lines TO tally_app");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      await tx.$executeRawUnsafe(`SELECT set_config('app.organization_id', '${org!.id}', true)`);
      // The trigger sees only NEW (the draft), so this succeeds.
      await tx.$executeRawUnsafe(`UPDATE invoice_lines SET invoice_id = '${draft}' WHERE id = '${moved!.id}'`);
      const [after] = await tx.$queryRawUnsafe<{ total: string; lines: string }[]>(
        `SELECT i.total_minor::text AS total, (SELECT sum(quantity * unit_price_minor)::text FROM invoice_lines l WHERE l.invoice_id = i.id) AS lines
         FROM invoices i WHERE i.id = '${open}'`);
      return after;
    });
    // Expected: the UPDATE is refused (TL008). Actually: it succeeds, and the OPEN invoice's stored total (5100)
    // no longer matches its remaining line (100).
    expect(value).toBeUndefined();
    expect(String((error as Error | undefined)?.message)).toMatch(/TL008|final/);
  });
});
