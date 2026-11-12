// WHAT'S WRONG: the role check's new trigger check (src/server/db/role-check.ts, readRoleFacts' missing_triggers)
// asks only that each guard trigger exists with tgenabled = 'O' ("fires for ordinary sessions"). It never asks
// whether THIS connection is an ordinary session: with session_replication_role = replica (a superuser's
// ALTER ROLE tally_app / ALTER DATABASE ... SET session_replication_role = replica -- the usual trick to load data
// "without triggers", or a database set up as a logical-replication subscriber), no 'O' trigger fires: not
// invoices_guard, invoice_lines_guard, invoice_counters_guard, nor the foreign keys' RI triggers (so the
// composite keys that keep tenants apart aren't checked either). The role check passes such a connection. It is
// the same kind of inherited setting as the app.organization_id preset the check already refuses.
// Second, the opposite mistake: a trigger set to ENABLE ALWAYS ('A', fires in every session, replica included --
// the stricter setting, and the natural fix for the first problem) is reported as "missing or disabled".
// WHY IT MATTERS: the check is what's meant to stop the application starting on a database where the life
// cycle and gapless numbering aren't enforced; here it reports nothing while a tally_app statement sets the
// counter to 41 directly.
// SUGGESTED FIX: refuse current_setting('session_replication_role') <> 'origin' (and report it); accept
// tgenabled IN ('O', 'A') (or require 'A' and make the migration ENABLE ALWAYS the three guards).
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

describe("the role check and triggers that don't fire", () => {
  it("refuses a tally_app connection in which no trigger fires (session_replication_role = replica)", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      const [org] = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO organizations (name, slug) VALUES ('Rep', 'rep-${unique()}') RETURNING id::text`);
      // What ALTER ROLE tally_app SET session_replication_role = replica gives every tally_app connection.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      await tx.$executeRawUnsafe(`SELECT set_config('app.organization_id', '${org!.id}', true)`);
      // The impact: invoice_counters_guard doesn't fire, so the application role writes the counter directly.
      await tx.$executeRawUnsafe(`INSERT INTO invoice_counters (organization_id, last_number) VALUES ('${org!.id}', 41)`);
      const [counter] = await tx.$queryRawUnsafe<{ n: number }[]>(`SELECT last_number AS n FROM invoice_counters`);
      await tx.$executeRawUnsafe(`SELECT set_config('app.organization_id', '', true)`);
      // Ignore the one problem SET ROLE itself causes in this harness.
      const problems = roleProblems(await readRoleFacts(tx)).filter((p) => !/logged in as/.test(p));
      return { counter: counter!.n, problems };
    });
    expect(error).toBeUndefined();
    expect(value!.counter).toBe(41); // the guard really didn't fire
    expect(value!.problems.join("; ")).toMatch(/replica|trigger/i);
  });

  it("doesn't report a guard trigger set to ENABLE ALWAYS (it fires in every session) as missing", async () => {
    const { value, error } = await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE invoices ENABLE ALWAYS TRIGGER invoices_guard");
      await tx.$executeRawUnsafe("SET LOCAL ROLE tally_app");
      return (await readRoleFacts(tx)).missingTriggers;
    });
    expect(error).toBeUndefined();
    expect(value).toEqual([]);
  });
});
