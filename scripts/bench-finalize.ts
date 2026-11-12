// What gapless numbering costs (README, "Results (day 2)").
//
//   npm run bench:finalize      # seeds tally_bench, then measures; prints a table and writes JSON
//
// Every finalization in an organization takes its number from that organization's invoice_counters row,
// whose lock is held until the transaction commits: finalizations in one organization take turns, by design
// (that's what makes the numbers gapless). This measures the price: the same number of finalizations
//   same org     C workers finalizing drafts of one organization
//   spread       C workers, each finalizing drafts of its own organization
// for each concurrency C, on a pool of C connections, through the application's path (withTenant as tally_app,
// finalize() from the services). Then it checks every organization's numbers are exactly 1..n, and times the
// PDF writer on a 2-line and a 100-line invoice.
//
// Synthetic data. Environment: BENCH_ADMIN_URL / BENCH_APP_URL / BENCH_OWNER_URL as in bench-tenant.ts;
// BENCH_FINALIZATIONS per case (default 1000), BENCH_CONCURRENCY (default "1,4,16"), BENCH_OUT.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import pg from "pg";
import { createDb } from "../src/server/db/client";
import { withTenant } from "../src/server/db/tenant";
import { renderInvoicePdf } from "../src/server/invoices/pdf";
import { finalize } from "../src/server/invoices/service";
import { sampleInvoice } from "../tests/fixtures/invoice";

const ADMIN_URL = process.env.BENCH_ADMIN_URL ?? "postgresql://localhost:5432/tally_bench";
const APP_URL = process.env.BENCH_APP_URL ?? "postgresql://tally_app@localhost:5432/tally_bench";
const OWNER_URL = process.env.BENCH_OWNER_URL ?? "postgresql://tally_owner@localhost:5432/tally_bench";
const PER_CASE = Number(process.env.BENCH_FINALIZATIONS ?? 1000);
const CONCURRENCY = (process.env.BENCH_CONCURRENCY ?? "1,4,16").split(",").map(Number);
const WARMUP = Math.max(20, Math.floor(PER_CASE / 10));
const LINES_PER_INVOICE = 5;

/** Drafts with lines, as a superuser (no RLS): `orgs` organizations with `perOrg` drafts each. */
async function seed(admin: pg.Client, label: string, orgs: number, perOrg: number): Promise<string[][]> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) SELECT 'Bench ' || $1 || ' ' || i, 'bench-' || $1 || '-' || i
     FROM generate_series(1, $2) AS i RETURNING id`,
    [label, orgs],
  );
  const orgIds = rows.map((r) => r.id);
  await admin.query(
    `INSERT INTO customers (organization_id, name, email) SELECT id, 'Customer', 'c@example.com' FROM unnest($1::uuid[]) AS id`,
    [orgIds],
  );
  await admin.query(
    `INSERT INTO invoices (organization_id, customer_id, currency)
     SELECT c.organization_id, c.id, 'USD' FROM customers c CROSS JOIN generate_series(1, $2)
     WHERE c.organization_id = ANY($1::uuid[])`,
    [orgIds, perOrg],
  );
  await admin.query(
    `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor, tax_rate)
     SELECT i.organization_id, i.id, p, 'Work', 1.5, 1999 + p, CASE WHEN p % 2 = 0 THEN 8.875 ELSE 0 END
     FROM invoices i CROSS JOIN generate_series(1, $2) AS p WHERE i.organization_id = ANY($1::uuid[])`,
    [orgIds, LINES_PER_INVOICE],
  );
  const drafts = await admin.query<{ organization_id: string; ids: string[] }>(
    `SELECT organization_id, array_agg(id ORDER BY id) AS ids FROM invoices
     WHERE organization_id = ANY($1::uuid[]) GROUP BY organization_id`,
    [orgIds],
  );
  const byOrg = new Map(drafts.rows.map((r) => [r.organization_id, r.ids]));
  return orgIds.map((id) => [id, ...byOrg.get(id)!]);
}

interface CaseResult {
  name: string;
  concurrency: number;
  finalizations: number;
  perSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

const nearestRank = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;

/** Runs `work` (one [orgId, invoiceId] per finalization) on `concurrency` workers; latencies after warm-up. */
async function run(name: string, concurrency: number, queues: [string, string][][]): Promise<CaseResult> {
  const app = createDb(APP_URL, { max: concurrency });
  try {
    const latencies: number[] = [];
    let done = 0;
    let measuredStart = 0;
    let measuredEnd = 0;
    await Promise.all(
      queues.map(async (queue) => {
        for (const [orgId, invoiceId] of queue) {
          const start = performance.now();
          const result = await withTenant(orgId, (tx) => finalize(tx, invoiceId, 30), app);
          const end = performance.now();
          if (!result.ok) throw new Error(`finalize failed: ${result.reason}`);
          done++;
          if (done === WARMUP) measuredStart = end;
          if (done > WARMUP) {
            latencies.push(end - start);
            measuredEnd = end;
          }
        }
      }),
    );
    latencies.sort((a, b) => a - b);
    return {
      name,
      concurrency,
      finalizations: latencies.length,
      perSecond: Math.round(latencies.length / ((measuredEnd - measuredStart) / 1000)),
      p50Ms: Number(nearestRank(latencies, 0.5).toFixed(2)),
      p95Ms: Number(nearestRank(latencies, 0.95).toFixed(2)),
      p99Ms: Number(nearestRank(latencies, 0.99).toFixed(2)),
    };
  } finally {
    await app.$disconnect();
  }
}

function pdfTimes(): { lines: number; medianMs: number; bytes: number }[] {
  return [2, 100].map((count) => {
    const lines = Array.from({ length: count }, (_, i) => ({ description: `Item ${i + 1}`, quantity: 1500n, unitPriceMinor: BigInt(1999 + i), taxRate: i % 2 ? 8875n : 0n }));
    const invoice = sampleInvoice({ lines });
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 220; i++) {
      const start = performance.now();
      bytes = renderInvoicePdf({ organizationName: "Bench", invoice }).length;
      if (i >= 20) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    return { lines: count, medianMs: Number(nearestRank(times, 0.5).toFixed(3)), bytes };
  });
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const monoStart = performance.now();
  const load = loadavg()[0]!;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: OWNER_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const results: CaseResult[] = [];
  try {
    // TRUNCATE skips row triggers, so the final invoices from an earlier run go too.
    await admin.query("TRUNCATE users, organizations CASCADE");
    const total = PER_CASE + WARMUP;
    for (const c of CONCURRENCY) {
      // Same org: one organization's drafts, dealt round-robin to c workers.
      const [same] = await seed(admin, `same-${c}`, 1, total);
      const [orgId, ...ids] = same!;
      const sameQueues = Array.from({ length: c }, (_, w) => ids.filter((_, i) => i % c === w).map((id): [string, string] => [orgId!, id]));
      results.push(await run("same org", c, sameQueues));
      // Spread: c organizations, worker w finalizing only organization w's drafts.
      const spread = await seed(admin, `spread-${c}`, c, Math.ceil(total / c));
      results.push(await run("spread", c, spread.map(([org, ...drafts]) => drafts.map((id): [string, string] => [org!, id]))));
    }
    await admin.query("ANALYZE invoices");
    // The point of the lock: every organization's numbers are exactly 1..n.
    const { rows: gaps } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT organization_id, count(*) AS c, min(number) AS lo, max(number) AS hi, count(DISTINCT number) AS d
         FROM invoices WHERE status = 'OPEN' GROUP BY organization_id) s
       WHERE lo <> 1 OR hi <> c OR d <> c`,
    );
    if (gaps[0]!.n !== "0") throw new Error(`${gaps[0]!.n} organizations have gaps or repeats`);
  } finally {
    await admin.end();
  }
  const pdf = pdfTimes();
  const sleptMs = Math.round(Date.now() - wallStart - (performance.now() - monoStart));
  const report = { perCase: PER_CASE, warmup: WARMUP, linesPerInvoice: LINES_PER_INVOICE, cpu: cpus()[0]?.model, loadAverageAtStart: Number(load.toFixed(2)), loadAverageAtEnd: Number(loadavg()[0]!.toFixed(2)), sleptMs, results, pdf };
  writeFileSync(process.env.BENCH_OUT ?? "bench-finalize.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${PER_CASE} finalizations per case (after ${WARMUP} warm-up), ${LINES_PER_INVOICE} lines each; load ${report.loadAverageAtStart} → ${report.loadAverageAtEnd}, slept ${sleptMs} ms`);
  console.log("case       workers  per second   p50 ms   p95 ms   p99 ms");
  for (const r of results) {
    console.log(`${r.name.padEnd(10)} ${String(r.concurrency).padStart(7)} ${String(r.perSecond).padStart(11)} ${r.p50Ms.toFixed(2).padStart(8)} ${r.p95Ms.toFixed(2).padStart(8)} ${r.p99Ms.toFixed(2).padStart(8)}`);
  }
  console.log("every organization's numbers are exactly 1..n");
  for (const p of pdf) console.log(`PDF, ${p.lines} lines: median ${p.medianMs} ms, ${p.bytes} bytes`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
