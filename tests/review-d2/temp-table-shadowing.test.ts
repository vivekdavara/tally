// Adapted for this repository: the GRANT TEMPORARY names current_database() instead of the reviewer's tally_review.
// WHAT'S WRONG: invoices_guard, invoice_lines_guard and invoice_totals() pin `SET search_path = pg_catalog,
// public`, but Postgres still searches the session's temporary schema FIRST for tables when pg_temp isn't
// listed explicitly. A role that can create temporary tables can therefore shadow invoice_lines (or invoices,
// or invoice_counters) for the trigger: finalization then stores totals computed from fake lines (or takes a
// number from a fake counter; or the line guard reads a fake 'DRAFT' status and lets a final invoice's lines
// change). Today scripts/db-setup.sh's `REVOKE ALL ON DATABASE ... FROM PUBLIC` takes TEMP away from tally_app,
// so this is latent -- but nothing checks it: the startup role check (src/server/db/role-check.ts) doesn't look
// at TEMP (nor CREATE on schema public), so a database created any other way (a managed Postgres, a restored
// dump, PUBLIC's default TEMP grant) passes the check with the triggers defeatable.
// WHY IT MATTERS: the triggers are the only thing guaranteeing totals and the life cycle for "every writer".
// SUGGESTED FIX: `SET search_path = pg_catalog, public, pg_temp` (pg_temp explicitly last) on all three
// functions, or schema-qualify every table (public.invoice_lines, ...); and have the role check refuse TEMP on
// the database and CREATE on schema public (has_database_privilege / has_schema_privilege).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { readRoleFacts, roleProblems } from "@/server/db/role-check";
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

describe("temporary tables shadow the tables the invoice triggers read", () => {
  it("the role check refuses a tally_app that can create temporary tables", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe("DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO tally_app', current_database()); END $$");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      // Ignore the one problem SET ROLE itself causes in this harness.
      return roleProblems(await readRoleFacts(tx)).filter((p) => !/logged in as/.test(p));
    });
    expect(error).toBeUndefined();
    expect(value!.join("; ")).toMatch(/TEMP/i);
  });

  it("finalization stores the totals of the real lines even if the session has a temp invoice_lines", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      const [org] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO organizations (name, slug) VALUES ('Tmp', 'tmp-${unique()}') RETURNING id::text`);
      const [cust] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO customers (organization_id, name, email) VALUES ('${org!.id}', 'C', 'c-${unique()}@example.com') RETURNING id::text`);
      const [inv] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO invoices (organization_id, customer_id, currency) VALUES ('${org!.id}', '${cust!.id}', 'USD') RETURNING id::text`);
      await tx.$executeRawUnsafe(
        `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor)
         VALUES ('${org!.id}', '${inv!.id}', 1, 'Real', 1, 100000)`);

      await tx.$executeRawUnsafe("DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO tally_app', current_database()); END $$");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      await tx.$executeRawUnsafe(`SELECT set_config('app.organization_id', '${org!.id}', true)`);
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE invoice_lines (organization_id uuid, invoice_id uuid, quantity numeric, unit_price_minor bigint, tax_rate numeric) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.invoice_lines VALUES ('${org!.id}', '${inv!.id}', 1, 1, 0)`);
      await tx.$executeRawUnsafe(`UPDATE public.invoices SET status = 'OPEN', due_on = current_date + 30 WHERE id = '${inv!.id}'`);
      const [row] = await tx.$queryRawUnsafe<{ total: string; real: string }[]>(
        `SELECT i.total_minor::text AS total,
                (SELECT sum(round(quantity * unit_price_minor))::text FROM public.invoice_lines l WHERE l.invoice_id = i.id) AS real
         FROM public.invoices i WHERE i.id = '${inv!.id}'`);
      return row;
    });
    expect(error).toBeUndefined();
    // Actually: total '1' (the temp table's fake line) for an invoice whose only real line is 100000.
    expect(value!.total).toBe(value!.real);
  });

  it("a final invoice's lines can't be changed even if the session has a temp invoices table saying DRAFT", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      const [org] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO organizations (name, slug) VALUES ('Tmp', 'tmp-${unique()}') RETURNING id::text`);
      const [cust] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO customers (organization_id, name, email) VALUES ('${org!.id}', 'C', 'c-${unique()}@example.com') RETURNING id::text`);
      const [inv] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO invoices (organization_id, customer_id, currency) VALUES ('${org!.id}', '${cust!.id}', 'USD') RETURNING id::text`);
      await tx.$executeRawUnsafe(
        `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor)
         VALUES ('${org!.id}', '${inv!.id}', 1, 'Real', 1, 100000)`);
      await tx.$executeRawUnsafe(`UPDATE invoices SET status = 'OPEN', due_on = current_date + 30 WHERE id = '${inv!.id}'`);

      await tx.$executeRawUnsafe("DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO tally_app', current_database()); END $$");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      await tx.$executeRawUnsafe(`SELECT set_config('app.organization_id', '${org!.id}', true)`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE invoices (organization_id uuid, id uuid, status public.invoice_status) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.invoices VALUES ('${org!.id}', '${inv!.id}', 'DRAFT')`);
      await tx.$executeRawUnsafe(`UPDATE public.invoice_lines SET unit_price_minor = 1 WHERE invoice_id = '${inv!.id}'`);
      const [row] = await tx.$queryRawUnsafe<{ total: string; real: string }[]>(
        `SELECT i.total_minor::text AS total,
                (SELECT sum(round(quantity * unit_price_minor))::text FROM public.invoice_lines l WHERE l.invoice_id = i.id) AS real
         FROM public.invoices i WHERE i.id = '${inv!.id}'`);
      return row;
    });
    // Expected: the line UPDATE is refused (TL008). Actually: it succeeds; the OPEN invoice's line now sums to 1.
    expect(value).toBeUndefined();
    expect(String((error as Error | undefined)?.message)).toMatch(/TL008|final/);
  });
});
