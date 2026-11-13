// What the webhook path costs (README, "Results (day 3)").
//
//   npm run bench:webhook       # seeds tally_bench, then measures; prints a table and writes JSON
//
// For each concurrency C: N fresh checkout.session.completed events (each paying a different open invoice of one
// of 16 organizations) go through handleStripeWebhook on C workers sharing a pool of C connections: signature
// check, parsing, and the event's transaction as tally_app (inbox insert, invoice and payment locks, both updates,
// the outcome). Then the same N events again, as Stripe's retries would send them: each must answer "duplicate"
// and change nothing. Then it checks every invoice is PAID exactly once, and times signature verification alone.
//
// Synthetic data; events are built and signed here the way Stripe would. Environment: BENCH_ADMIN_URL /
// BENCH_APP_URL / BENCH_OWNER_URL as in bench-tenant.ts; BENCH_EVENTS per case (default 2000), BENCH_CONCURRENCY
// (default "1,8,32"), BENCH_OUT.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import pg from "pg";
import { computeSignature, signatureHeader, verifySignature } from "../src/server/billing/signature";
import { handleStripeWebhook, type WebhookDeps } from "../src/server/billing/webhook";
import { createDb } from "../src/server/db/client";
import { withTenant } from "../src/server/db/tenant";

const ADMIN_URL = process.env.BENCH_ADMIN_URL ?? "postgresql://localhost:5432/tally_bench";
const APP_URL = process.env.BENCH_APP_URL ?? "postgresql://tally_app@localhost:5432/tally_bench";
const OWNER_URL = process.env.BENCH_OWNER_URL ?? "postgresql://tally_owner@localhost:5432/tally_bench";
const PER_CASE = Number(process.env.BENCH_EVENTS ?? 2000);
const CONCURRENCY = (process.env.BENCH_CONCURRENCY ?? "1,8,32").split(",").map(Number);
const WARMUP = Math.max(20, Math.floor(PER_CASE / 10));
const ORGS = 16;
const SECRET = `whsec_bench_${Date.now()}`;

interface Target {
  organizationId: string;
  invoiceId: string;
  sessionId: string;
  amount: string;
}

/** `count` open invoices with a pending payment each, spread over ORGS organizations, as a superuser. */
async function seed(admin: pg.Client, label: string, count: number): Promise<Target[]> {
  const orgs = await admin.query<{ id: string }>(
    `INSERT INTO organizations (name, slug) SELECT 'Bench ' || $1 || ' ' || i, 'wh-' || $1 || '-' || i FROM generate_series(1, $2) AS i RETURNING id`,
    [label, ORGS],
  );
  const orgIds = orgs.rows.map((r) => r.id);
  await admin.query(`INSERT INTO customers (organization_id, name, email) SELECT id, 'Customer', 'c@example.com' FROM unnest($1::uuid[]) AS id`, [orgIds]);
  // Invoice k goes to organization k mod ORGS.
  await admin.query(
    `INSERT INTO invoices (organization_id, customer_id, currency)
     SELECT c.organization_id, c.id, 'USD' FROM generate_series(0, $2 - 1) AS k
     JOIN LATERAL (SELECT ($1::uuid[])[k % ${ORGS} + 1] AS org) o ON true
     JOIN customers c ON c.organization_id = o.org`,
    [orgIds, count],
  );
  await admin.query(
    `INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor, tax_rate)
     SELECT organization_id, id, 1, 'Work', 1, 5342, 0 FROM invoices WHERE organization_id = ANY($1::uuid[])`,
    [orgIds],
  );
  await admin.query(`UPDATE invoices SET status = 'OPEN', due_on = current_date + 30 WHERE organization_id = ANY($1::uuid[])`, [orgIds]);
  const rows = await admin.query<{ organization_id: string; invoice_id: string; session: string; amount: string }>(
    `INSERT INTO payments (organization_id, invoice_id, provider, checkout_session_id, checkout_url, amount_minor, currency, expires_at)
     SELECT organization_id, id, 'mock', 'cs_bench_' || replace(id::text, '-', ''), '/mock-checkout/x', total_minor, currency, now() + interval '1 day'
     FROM invoices WHERE organization_id = ANY($1::uuid[])
     RETURNING organization_id, invoice_id, checkout_session_id AS session, amount_minor::text AS amount`,
    [orgIds],
  );
  return rows.rows.map((r) => ({ organizationId: r.organization_id, invoiceId: r.invoice_id, sessionId: r.session, amount: r.amount }));
}

function event(target: Target, n: number): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: `evt_bench_${target.sessionId.slice(9)}_${n}`,
      object: "event",
      api_version: "bench",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type: "checkout.session.completed",
      data: {
        object: {
          id: target.sessionId,
          object: "checkout.session",
          amount_total: Number(target.amount),
          currency: "usd",
          customer_email: "c@example.com",
          metadata: { organization_id: target.organizationId, invoice_id: target.invoiceId },
          mode: "payment",
          payment_intent: `pi_bench_${n}`,
          payment_status: "paid",
          status: "complete",
        },
      },
    }),
  );
}

interface CaseResult {
  name: string;
  concurrency: number;
  events: number;
  perSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

const nearestRank = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;

async function deliverAll(name: string, concurrency: number, bodies: Buffer[], expect: string, deps: WebhookDeps): Promise<CaseResult> {
  const latencies: number[] = [];
  let next = 0;
  let done = 0;
  let measuredStart = 0;
  let measuredEnd = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < bodies.length) {
        const body = bodies[next++]!;
        const start = performance.now();
        // Signed at delivery, as Stripe does (each retry carries a fresh timestamp).
        const answer = await handleStripeWebhook(body, signatureHeader(SECRET, Math.floor(Date.now() / 1000), body), deps);
        const end = performance.now();
        const got = answer.body.outcome ?? answer.body.result;
        if (got !== expect) throw new Error(`${name}: expected ${expect}, got ${answer.status} ${JSON.stringify(answer.body)}`);
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
    events: latencies.length,
    perSecond: Math.round(latencies.length / ((measuredEnd - measuredStart) / 1000)),
    p50Ms: Number(nearestRank(latencies, 0.5).toFixed(2)),
    p95Ms: Number(nearestRank(latencies, 0.95).toFixed(2)),
    p99Ms: Number(nearestRank(latencies, 0.99).toFixed(2)),
  };
}

function signatureMicros(): { bodyBytes: number; medianUs: number } {
  const body = event({ organizationId: "00000000-0000-4000-8000-000000000001", invoiceId: "00000000-0000-4000-8000-000000000002", sessionId: "cs_bench_x", amount: "5342" }, 1);
  const header = `t=${Math.floor(Date.now() / 1000)},v1=${computeSignature(SECRET, Math.floor(Date.now() / 1000), body)}`;
  const times: number[] = [];
  for (let i = 0; i < 21_000; i++) {
    const start = performance.now();
    verifySignature(body, header, SECRET);
    if (i >= 1_000) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { bodyBytes: body.length, medianUs: Number((nearestRank(times, 0.5) * 1000).toFixed(1)) };
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const monoStart = performance.now();
  const load = loadavg()[0]!;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], { env: { ...process.env, MIGRATE_DATABASE_URL: OWNER_URL, PRISMA_HIDE_UPDATE_MESSAGE: "1" }, stdio: "pipe" });
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const results: CaseResult[] = [];
  try {
    await admin.query("TRUNCATE users, organizations CASCADE");
    for (const c of CONCURRENCY) {
      const targets = await seed(admin, `c${c}`, PER_CASE + WARMUP);
      const bodies = targets.map((t, i) => event(t, i));
      const app = createDb(APP_URL, { max: c });
      const deps: WebhookDeps = {
        secret: SECRET,
        run: (e, fn) => withTenant(e.organizationId, fn, app),
        organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
      };
      try {
        results.push(await deliverAll("fresh", c, bodies, "invoice-paid", deps));
        results.push(await deliverAll("redelivered", c, bodies, "duplicate", deps));
      } finally {
        await app.$disconnect();
      }
      const check = await admin.query<{ paid: string; succeeded: string; events: string; nulls: string }>(
        `WITH p AS (SELECT p.id, p.status, i.status AS invoice FROM payments p
                    JOIN invoices i ON i.organization_id = p.organization_id AND i.id = p.invoice_id
                    WHERE p.checkout_session_id = ANY($1::text[]))
         SELECT count(*) FILTER (WHERE invoice = 'PAID') AS paid, count(*) FILTER (WHERE status = 'SUCCEEDED') AS succeeded,
                (SELECT count(*) FROM stripe_events e WHERE e.payment_id IN (SELECT id FROM p)) AS events,
                (SELECT count(*) FROM stripe_events WHERE outcome IS NULL) AS nulls
         FROM p`,
        [targets.map((t) => t.sessionId)],
      );
      const r = check.rows[0]!;
      const n = String(targets.length);
      if (r.paid !== n || r.succeeded !== n || r.events !== n || r.nulls !== "0") {
        throw new Error(`after c=${c}: ${JSON.stringify(r)} for ${n} invoices`);
      }
    }
  } finally {
    await admin.end();
  }
  const signature = signatureMicros();
  const sleptMs = Date.now() - wallStart - (performance.now() - monoStart);
  const out = { when: new Date().toISOString(), cpu: cpus()[0]?.model, loadAtStart: load, sleptMs: Math.round(sleptMs), perCase: PER_CASE, warmup: WARMUP, orgs: ORGS, results, signature };
  console.table(results);
  console.log(`signature check alone: median ${signature.medianUs} µs for a ${signature.bodyBytes}-byte body`);
  console.log(`load at start ${load.toFixed(2)}; slept ${out.sleptMs} ms during the run; every invoice paid once, one event row each`);
  writeFileSync(process.env.BENCH_OUT ?? "bench-webhook.json", `${JSON.stringify(out, null, 2)}\n`);
}

await main();
