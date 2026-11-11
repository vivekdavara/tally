import { execFileSync } from "node:child_process";
import pg from "pg";

/** Brings tally_test to the latest migration and empties it, once per test run. */
export default async function setup(): Promise<void> {
  const ownerUrl = process.env.TEST_MIGRATE_DATABASE_URL ?? "postgresql://tally_owner@localhost:5432/tally_test";
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: ownerUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // TRUNCATE isn't subject to row-level security; CASCADE reaches every table that references these.
    await client.query("TRUNCATE users, organizations CASCADE");
  } finally {
    await client.end();
  }
}
