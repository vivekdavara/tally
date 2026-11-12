// WHAT'S WRONG: deleting an organization with a final invoice works today only because of the order in which
// Postgres fires the organizations table's ON DELETE CASCADE triggers: by trigger name, RI_ConstraintTrigger_a_<oid>,
// i.e. (as text) the order the foreign keys happened to be created in. invoices_organization_id_fkey is older than
// invoice_lines_organization_id_fkey, so the invoices go first and their lines follow through the invoice's own
// cascade. If the lines' cascade fires first, invoice_lines_guard (migrations/*_review_d2, unchanged in this
// respect from *_invoicing) still finds the invoice, sees it isn't a draft and raises TL008 -- the organization
// can't be deleted at all. Re-creating the invoices -> organizations key (any future migration that touches
// that relation: Prisma drops and re-adds the constraint) flips the order; so does an OID wraparound past a digit
// boundary on a long-lived cluster (names compare as text: ..._a_10000001 < ..._a_9999998).
// The invoices_guard has an explicit "the organization is being deleted" exception; invoice_lines_guard doesn't.
// WHY IT MATTERS: DESIGN.md / the invoices_guard comment promise that deleting an organization takes its final
// invoices with it; whether it does depends on constraint creation history.
// SUGGESTED FIX: give invoice_lines_guard the same exception as invoices_guard (skip the status check on DELETE
// when the organization row no longer exists), and keep the integration test but also run it with the lines'
// cascade first (as this test does).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { adminDb, unique } from "../helpers";

let admin: Db;
beforeAll(() => {
  admin = adminDb({ max: 1 });
});
afterAll(async () => {
  await admin.$disconnect();
});

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

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

describe("deleting an organization that has a final invoice with lines", () => {
  it("succeeds whichever of the organization's cascades fires first", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      const [org] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO organizations (name, slug) VALUES ('Gone', 'gone-${unique()}') RETURNING id::text`);
      const [cust] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO customers (organization_id, name, email) VALUES ('${org!.id}', 'C', 'c-${unique()}@example.com') RETURNING id::text`);
      const [inv] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO invoices (organization_id, customer_id, currency) VALUES ('${org!.id}', '${cust!.id}', 'USD') RETURNING id::text`);
      await tx.$executeRawUnsafe(
        `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor)
         VALUES ('${org!.id}', '${inv!.id}', 1, 'Work', 1, 100)`);
      await tx.$executeRawUnsafe(`UPDATE invoices SET status = 'OPEN', due_on = current_date + 30 WHERE id = '${inv!.id}'`);
      // The same key, re-created (as a later migration would): its cascade trigger now sorts after the lines'.
      await tx.$executeRawUnsafe(`ALTER TABLE invoices DROP CONSTRAINT invoices_organization_id_fkey`);
      await tx.$executeRawUnsafe(
        `ALTER TABLE invoices ADD CONSTRAINT invoices_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE ON UPDATE NO ACTION`);
      await tx.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${org!.id}'`);
      const [left] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM invoices WHERE organization_id = '${org!.id}'`);
      return left!.n;
    });
    expect(error === undefined ? undefined : String(error).match(/TL\d+|tally: [^\n"]+/)?.[0]).toBeUndefined();
    expect(value).toBe(0);
  });
});
