import { execFileSync } from "node:child_process";
import pg from "pg";

// A run holds this session-level advisory lock on its database from setup to teardown. Two runs against the
// same database would otherwise interfere silently: each run's setup empties the tables (TRUNCATE below), so a
// second run starting mid-way deleted the first run's organizations under its tests. That happened twice on
// 2026-11-12 (a nested write failed on customers_organization_id_fkey) while a review agent ran tests on the same
// machine; now the second run stops at once with a clear message instead.
const RUN_LOCK = 0x7a11_7e57;

/** Brings tally_test to the latest migration and empties it, once per test run. */
export default async function setup(): Promise<() => Promise<void>> {
  const ownerUrl = process.env.TEST_MIGRATE_DATABASE_URL ?? "postgresql://tally_owner@localhost:5432/tally_test";
  const lock = new pg.Client({ connectionString: ownerUrl });
  await lock.connect();
  const { rows } = await lock.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [RUN_LOCK]);
  if (!rows[0]?.ok) {
    await lock.end();
    throw new Error(`another test run is using ${new URL(ownerUrl).pathname.slice(1)}: wait for it, or point TEST_*_DATABASE_URL at another database`);
  }
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: ownerUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // TRUNCATE isn't subject to row-level security; CASCADE reaches every table that references these.
    await client.query("TRUNCATE users, organizations CASCADE");
    // Connections to the test database run in a time zone that isn't UTC, here and in CI (whose server is UTC), so
    // a timestamp that loses its zone on the way in shows up as hours off instead of passing by luck (day 3: a Date
    // sent to raw SQL was read as New York time). For connections opened after this, i.e. every test's.
    const db = new URL(ownerUrl).pathname.slice(1);
    await client.query(`ALTER DATABASE "${db.replaceAll('"', '""')}" SET timezone TO 'America/New_York'`);
  } finally {
    await client.end();
  }
  // Held until the run ends (the lock goes with the connection).
  return async () => {
    await lock.end();
  };
}
