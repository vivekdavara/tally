// What day 4 costs (README, "Results (day 4)").
//
//   scripts/db-setup.sh tally_bench && npm run bench:reminders
//
// 1. The overdue-reminders job: N open invoices, 7 to 13 days past due, spread over 16 organizations, then
//    runReminderJob (queue, then claim / send / record in batches of 50) with an in-memory mailer, on 1 worker and
//    on 2 workers at once (a fresh seed each). Checks every reminder was sent exactly once and recorded.
// 2. The role re-check requireTenant's run makes as its first statement (the member's role, FOR SHARE): the same
//    small transaction (the tenant setting, then a count of the organization's customers) with and without it,
//    interleaved, as tally_app.
//
// Synthetic data. Environment: BENCH_ADMIN_URL / BENCH_APP_URL as in bench-tenant.ts; BENCH_INVOICES (default 4000),
// BENCH_RECHECKS (default 3000), BENCH_OUT. Prints how long the Mac slept during each case (Date.now() keeps
// counting during sleep, performance.now() doesn't): a case with sleep in it is not a measurement.
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { createDb } from "../src/server/db/client";
import { withTenant } from "../src/server/db/tenant";
import { MemoryMailer } from "../src/server/mail/mailer";
import { lockedRole } from "../src/server/orgs/locked-role";
import { runReminderJob } from "../src/server/reminders/job";

const ADMIN_URL = process.env.BENCH_ADMIN_URL ?? "postgresql://localhost:5432/tally_bench";
const APP_URL = process.env.BENCH_APP_URL ?? "postgresql://tally_app@localhost:5432/tally_bench";
const INVOICES = Number(process.env.BENCH_INVOICES ?? 4000);
const RECHECKS = Number(process.env.BENCH_RECHECKS ?? 3000);
const ORGS = 16;

const sleptMs = (() => {
  const offset = () => Date.now() - performance.now();
  return () => {
    const start = offset();
    return () => Math.max(0, Math.round(offset() - start));
  };
})();

/** `count` open invoices 7 to 13 days past due over ORGS new organizations, each with one member; as a superuser. */
async function seed(admin: pg.Client, label: string, count: number): Promise<{ orgIds: string[]; userIds: string[] }> {
  const orgs = await admin.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) SELECT 'Bench ' || $1 || ' ' || i, 'rm-' || $1 || '-' || i FROM generate_series(1, $2) AS i RETURNING id`,
    [label, ORGS],
  );
  const orgIds = orgs.rows.map((r) => r.id);
  const users = await admin.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) SELECT 'rm-' || $1 || '-' || i || '@example.com', 'Bench', 'x' FROM generate_series(1, $2) AS i RETURNING id`,
    [label, ORGS],
  );
  const userIds = users.rows.map((r) => r.id);
  await admin.query(`INSERT INTO memberships (organization_id, user_id, role) SELECT o, u, 'ADMIN' FROM unnest($1::uuid[], $2::uuid[]) AS t(o, u)`, [orgIds, userIds]);
  await admin.query(`INSERT INTO customers (organization_id, name, email) SELECT id, 'Customer', 'late@example.com' FROM unnest($1::uuid[]) AS id`, [orgIds]);
  await admin.query(
    `INSERT INTO invoices (organization_id, customer_id, currency)
     SELECT c.organization_id, c.id, 'USD' FROM generate_series(0, $2 - 1) AS k
     JOIN LATERAL (SELECT ($1::uuid[])[k % ${ORGS} + 1] AS org) o ON true
     JOIN customers c ON c.organization_id = o.org`,
    [orgIds, count],
  );
  await admin.query(
    `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor, tax_rate)
     SELECT organization_id, id, 1, 'Work', 1, 12000, 0 FROM invoices WHERE organization_id = ANY($1::uuid[])`,
    [orgIds],
  );
  // Finalized through the trigger (number, totals, bill-to), then moved into the past: time passing, as in the tests.
  await admin.query(`UPDATE invoices SET status = 'OPEN', due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date WHERE organization_id = ANY($1::uuid[])`, [orgIds]);
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  await admin.query(
    `UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - (7 + abs(hashtext(id::text)) % 7) WHERE organization_id = ANY($1::uuid[])`,
    [orgIds],
  );
  await admin.query("COMMIT");
  return { orgIds, userIds };
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function main() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const app = createDb(APP_URL, { max: 8 });
  const label = Date.now().toString(36);
  const results: Record<string, unknown> = { at: new Date().toISOString(), cpu: cpus()[0]?.model, loadavg: loadavg(), invoices: INVOICES, organizations: ORGS };
  try {
    // 1. The job.
    for (const workers of [1, 2]) {
      const { orgIds } = await seed(admin, `${label}w${workers}`, INVOICES);
      const mailer = new MemoryMailer();
      const forEach = async (fn: Parameters<Parameters<typeof runReminderJob>[0]["forEachOrganization"]>[0]) => {
        for (const id of orgIds) await fn(id, (f) => withTenant(id, f, app));
      };
      const slept = sleptMs();
      const start = performance.now();
      const reports = await Promise.all(
        Array.from({ length: workers }, () => runReminderJob({ forEachOrganization: forEach, mailer, appBaseUrl: "https://tally.example" })),
      );
      const ms = performance.now() - start;
      const sent = reports.reduce((n, r) => n + r.sent, 0);
      const errors = reports.flatMap((r) => r.errors);
      const recorded = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM reminders WHERE organization_id = ANY($1::uuid[]) AND sent_at IS NOT NULL`, [orgIds]);
      const keys = new Set(mailer.sent.map((m) => m.idempotencyKey));
      if (sent !== INVOICES || mailer.sent.length !== INVOICES || keys.size !== INVOICES || Number(recorded.rows[0]!.n) !== INVOICES || errors.length > 0) {
        throw new Error(`job check failed: sent ${sent}, mails ${mailer.sent.length}, distinct ${keys.size}, recorded ${recorded.rows[0]!.n}, errors ${errors.length}`);
      }
      const row = { workers, reminders: sent, ms: Math.round(ms), perSecond: Math.round((sent / ms) * 1000), sleptMs: slept() };
      results[`job_${workers}`] = row;
      console.log(`job: ${workers} worker(s): ${sent} reminders in ${row.ms} ms = ${row.perSecond}/s (slept ${row.sleptMs} ms)`);
    }

    // 2. The role re-check.
    const { orgIds, userIds } = await seed(admin, `${label}rc`, 32);
    const org = orgIds[0]!;
    const user = userIds[0]!;
    const plain = () => withTenant(org, (tx) => tx.customer.count(), app);
    const rechecked = () =>
      withTenant(
        org,
        async (tx) => {
          if ((await lockedRole(tx, user)) === null) throw new Error("not a member");
          return tx.customer.count();
        },
        app,
      );
    for (let i = 0; i < 300; i++) await (i % 2 ? plain() : rechecked());
    const times: { plain: number[]; rechecked: number[] } = { plain: [], rechecked: [] };
    const slept = sleptMs();
    for (let i = 0; i < RECHECKS * 2; i++) {
      const which = i % 2 === 0 ? "plain" : "rechecked";
      const t = performance.now();
      await (which === "plain" ? plain() : rechecked());
      times[which].push((performance.now() - t) * 1000);
    }
    const summary = Object.fromEntries(
      Object.entries(times).map(([k, v]) => {
        const s = [...v].sort((x, y) => x - y);
        return [k, { p50: Math.round(pct(s, 50)), p95: Math.round(pct(s, 95)), p99: Math.round(pct(s, 99)) }];
      }),
    );
    results.recheck = { ...summary, runs: RECHECKS, sleptMs: slept() };
    console.log(`role re-check (µs, ${RECHECKS} each, interleaved, slept ${slept()} ms):`);
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(10)} p50 ${v.p50}  p95 ${v.p95}  p99 ${v.p99}`);
  } finally {
    await app.$disconnect();
    await admin.end();
  }
  if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(results, null, 2));
}

await main();
