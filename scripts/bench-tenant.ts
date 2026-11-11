// What tenant isolation costs per query (README, "Results").
//
//   npm run bench            # seeds tally_bench, then measures; prints a table and writes JSON
//
// It compares one tenant's customer count three ways, each on a one-connection pool, sequentially:
//   bypass      a superuser client (row-level security skipped) with an explicit WHERE organization_id:
//               what the query would cost with no isolation at all; one round trip.
//   withTenant  the application's path: tally_app, BEGIN, set_config, the query (RLS adds the filter),
//               COMMIT; four round trips.
//   explicit    withTenant plus the explicit WHERE as well (belt and braces).
// and prints the plan Postgres chose for the RLS query, to check the policy uses the index.
//
// Synthetic data: BENCH_TENANTS organizations with BENCH_CUSTOMERS customers each. Environment:
//   BENCH_ADMIN_URL   a superuser connection to tally_bench (default: this machine's user over localhost)
//   BENCH_APP_URL     tally_app on tally_bench;  BENCH_OWNER_URL  tally_owner on tally_bench (migrations)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import pg from "pg";
import { createDb, type Db } from "../src/server/db/client";
import { withTenant } from "../src/server/db/tenant";

const ADMIN_URL = process.env.BENCH_ADMIN_URL ?? "postgresql://localhost:5432/tally_bench";
const APP_URL = process.env.BENCH_APP_URL ?? "postgresql://tally_app@localhost:5432/tally_bench";
const OWNER_URL = process.env.BENCH_OWNER_URL ?? "postgresql://tally_owner@localhost:5432/tally_bench";
const TENANTS = Number(process.env.BENCH_TENANTS ?? 100);
const CUSTOMERS = Number(process.env.BENCH_CUSTOMERS ?? 1000);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 3000);
const WARMUP = Math.max(200, Math.floor(ITERATIONS / 10));

async function seed(): Promise<string[]> {
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, MIGRATE_DATABASE_URL: OWNER_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rows: su } = await admin.query<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    if (!su[0]?.rolsuper) throw new Error("BENCH_ADMIN_URL must be a superuser (it bypasses RLS to seed)");
    await admin.query("TRUNCATE users, organizations CASCADE");
    await admin.query(
      `INSERT INTO organizations (name, slug)
       SELECT 'Bench ' || i, 'bench-' || i FROM generate_series(1, $1) AS i`,
      [TENANTS],
    );
    await admin.query(
      `INSERT INTO customers (organization_id, name, email)
       SELECT o.id, 'Customer ' || c, 'c' || c || '@example.com'
       FROM organizations o CROSS JOIN generate_series(1, $1) AS c`,
      [CUSTOMERS],
    );
    await admin.query("ANALYZE organizations, customers");
    const { rows } = await admin.query<{ id: string }>("SELECT id FROM organizations ORDER BY slug");
    return rows.map((r) => r.id);
  } finally {
    await admin.end();
  }
}

async function plan(orgId: string): Promise<{ rls: string[]; explicit: string[]; rlsMs: number }> {
  const app = new pg.Client({ connectionString: APP_URL });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await Promise.all([app.connect(), admin.connect()]);
  const nodes = (rows: { "QUERY PLAN": string }[]) =>
    rows.map((r) => r["QUERY PLAN"]).filter((l) => /Scan|Aggregate/.test(l)).map((l) => l.trim());
  try {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.organization_id', $1, true)", [orgId]);
    const rls = await app.query<{ "QUERY PLAN": string }>("EXPLAIN (ANALYZE, COSTS OFF) SELECT count(*) FROM customers");
    await app.query("COMMIT");
    const explicit = await admin.query<{ "QUERY PLAN": string }>(
      "EXPLAIN (ANALYZE, COSTS OFF) SELECT count(*) FROM customers WHERE organization_id = $1",
      [orgId],
    );
    const exec = rls.rows.map((r) => r["QUERY PLAN"]).find((l) => l.startsWith("Execution Time"));
    return { rls: nodes(rls.rows), explicit: nodes(explicit.rows), rlsMs: Number(exec?.match(/[\d.]+/)?.[0]) };
  } finally {
    await Promise.all([app.end(), admin.end()]);
  }
}

interface Stats {
  name: string;
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

function stats(name: string, samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest rank: the smallest sample with at least q of the samples at or below it.
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { name, n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), mean };
}

type Path = { name: string; run: (orgId: string) => Promise<number> };

/**
 * Interleaved: every iteration runs each path once, in an order rotated by the iteration, so a change in
 * machine load during the run lands on all paths alike instead of on whichever ran last.
 */
async function measure(paths: Path[], orgIds: string[]): Promise<Stats[]> {
  const samples = paths.map(() => [] as number[]);
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const orgId = orgIds[(i * 7) % orgIds.length]!;
    for (let k = 0; k < paths.length; k++) {
      const j = (i + k) % paths.length;
      const start = performance.now();
      const count = await paths[j]!.run(orgId);
      const micros = (performance.now() - start) * 1000;
      if (count !== CUSTOMERS) throw new Error(`${paths[j]!.name}: counted ${count}, expected ${CUSTOMERS}`);
      if (i >= WARMUP) samples[j]!.push(micros);
    }
  }
  return paths.map((p, j) => stats(p.name, samples[j]!));
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const monoStart = performance.now();
  const load = loadavg()[0]!;
  const orgIds = await seed();
  const bypass: Db = createDb(ADMIN_URL, { max: 1 });
  const app: Db = createDb(APP_URL, { max: 1 });
  try {
    const results = await measure(
      [
        { name: "bypass", run: (id) => bypass.customer.count({ where: { organizationId: id } }) },
        { name: "withTenant", run: (id) => withTenant(id, (tx) => tx.customer.count(), app) },
        {
          name: "explicit",
          run: (id) => withTenant(id, (tx) => tx.customer.count({ where: { organizationId: id } }), app),
        },
      ],
      orgIds,
    );
    const plans = await plan(orgIds[0]!);
    // On macOS performance.now() stops while the machine sleeps and Date.now() doesn't: a gap means the
    // run straddled a sleep and its numbers are void.
    const sleptMs = Math.round(Date.now() - wallStart - (performance.now() - monoStart));
    const report = {
      tenants: TENANTS,
      customersPerTenant: CUSTOMERS,
      iterations: ITERATIONS,
      warmup: WARMUP,
      cpu: cpus()[0]?.model,
      loadAverageAtStart: Number(load.toFixed(2)),
      sleptMs,
      results: results.map((r) => ({
        ...r,
        p50: Math.round(r.p50),
        p95: Math.round(r.p95),
        p99: Math.round(r.p99),
        mean: Math.round(r.mean),
      })),
      plans,
    };
    writeFileSync(process.env.BENCH_OUT ?? "bench-tenant.json", `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${TENANTS} tenants x ${CUSTOMERS} customers, ${ITERATIONS} counts per path (after ${WARMUP} warm-up), interleaved, one connection each`);
    console.log(`load average ${report.loadAverageAtStart} at start, slept ${sleptMs} ms during the run`);
    console.log("path         p50 µs   p95 µs   p99 µs  mean µs");
    for (const r of report.results) {
      console.log(
        `${r.name.padEnd(11)} ${String(r.p50).padStart(7)} ${String(r.p95).padStart(8)} ${String(r.p99).padStart(8)} ${String(r.mean).padStart(8)}`,
      );
    }
    console.log(`plan under RLS:   ${plans.rls.join(" <- ")} (${plans.rlsMs} ms)`);
    console.log(`plan as bypass:   ${plans.explicit.join(" <- ")}`);
  } finally {
    await Promise.all([bypass.$disconnect(), app.$disconnect()]);
  }
}

await main();
