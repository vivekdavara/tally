// The background worker (DESIGN.md, "Overdue reminders"): runs the jobs on an interval until SIGINT or SIGTERM.
//
//   DATABASE_URL=postgresql://tally_app@localhost:5432/tally npm run worker            # every hour
//   DATABASE_URL=... npm run worker -- --once                                          # one pass, then exit
//
// - Overdue reminders every REMINDER_INTERVAL_MINUTES (default 60). Mail goes to stdout, one JSON line per message
//   (ConsoleMailer): Tally ships no email provider.
// - With BILLING_PROVIDER=stripe, reconciliation of the last RECONCILE_HOURS (default 72) of Stripe events every
//   RECONCILE_INTERVAL_MINUTES (default 15), the same as scripts/reconcile.ts. The mock provider has no event log to
//   fetch outside the server process, so this job doesn't run in mock mode.
//
// Several workers may run at once: reminders are claimed with SKIP LOCKED and a lease, and reconciliation is
// idempotent. A stop signal lets the current step finish (each is one short transaction) and then exits 0.
import { readBillingConfig } from "../src/server/billing/config";
import { reconcileEvents } from "../src/server/billing/reconcile";
import { expireOthersWhenPaid } from "../src/server/billing/service";
import { StripeProvider } from "../src/server/billing/stripe-provider";
import { createDb } from "../src/server/db/client";
import { assertSafeAppRole } from "../src/server/db/role-check";
import { forEachOrganization, withTenant } from "../src/server/db/tenant";
import { ConsoleMailer } from "../src/server/mail/mailer";
import { runReminderJob } from "../src/server/reminders/job";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const once = process.argv.includes("--once");
const minutes = (name: string, fallback: number) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > 24 * 60) {
    console.error(`worker: ${name} must be between 0 and 1440 minutes`);
    process.exit(2);
  }
  return value;
};
const reminderEvery = minutes("REMINDER_INTERVAL_MINUTES", 60);
const reconcileEvery = minutes("RECONCILE_INTERVAL_MINUTES", 15);
const reconcileHours = Number(process.env.RECONCILE_HOURS ?? 72);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("worker: DATABASE_URL is not set");
  process.exit(2);
}

// Handlers first, so a signal during startup is a clean stop too.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stop.signal.aborted) process.exit(1);
    log({ worker: "stopping", signal });
    stop.abort();
  });
}

function log(entry: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

/**
 * Resolves after `ms`, or at once when the worker is told to stop, including when it already was: the abort event
 * fires once, so a listener added after a stop that came during a job never ran, and the worker slept out the whole
 * interval (review round 2 of day 4). The listener is removed when the timer wins, so sleeps don't pile them up.
 */
function sleep(ms: number): Promise<void> {
  if (stop.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      stop.signal.removeEventListener("abort", wake);
      resolve();
    }, ms);
    stop.signal.addEventListener("abort", wake, { once: true });
  });
}

const config = readBillingConfig();
const db = createDb(url, { max: 4 });
const mailer = new ConsoleMailer();
const stripe = config.provider === "stripe" ? new StripeProvider({ secretKey: config.stripeSecretKey! }) : null;
let failed = false;

async function reminders() {
  const report = await runReminderJob({ forEachOrganization: (fn) => forEachOrganization(fn, db), mailer, appBaseUrl: config.appBaseUrl, signal: stop.signal });
  log({ job: "reminders", ...report });
  // A failed send is retried on a later run, but for --once (cron) it is still a failure to report.
  if (report.errors.length > 0 || report.failed > 0) failed = true;
}

async function reconcile() {
  if (!stripe) return;
  const report = await reconcileEvents(stripe, new Date(Date.now() - reconcileHours * 3_600_000), {
    run: (event, fn) => withTenant(event.organizationId, fn, db),
    organizationExists: async (id) => (await db.organization.count({ where: { id } })) === 1,
    afterApplied: expireOthersWhenPaid(stripe, (event) => (fn) => withTenant(event.organizationId, fn, db)),
  });
  log({ job: "reconcile", ...report });
  if (report.notApplied.length > 0 || report.afterEffectsFailed.length > 0) failed = true;
}

/** Runs a job, logging (not throwing) a failure, so one bad run doesn't stop the worker. */
async function attempt(name: string, job: () => Promise<void>) {
  try {
    await job();
  } catch (error) {
    failed = true;
    log({ job: name, error: (error as Error).message });
  }
}

try {
  // The same refusal as the server's: never run as a role that row-level security doesn't bind.
  await assertSafeAppRole(db);
  log({ worker: "started", once, reminderEveryMinutes: reminderEvery, reconcile: stripe ? reconcileEvery : null });
  let nextReminders = 0;
  let nextReconcile = 0;
  do {
    const now = Date.now();
    if (now >= nextReminders) {
      await attempt("reminders", reminders);
      nextReminders = now + reminderEvery * 60_000;
    }
    if (stripe && now >= nextReconcile && !stop.signal.aborted) {
      await attempt("reconcile", reconcile);
      nextReconcile = now + reconcileEvery * 60_000;
    }
    if (once) break;
    await sleep(Math.max(1_000, Math.min(nextReminders, stripe ? nextReconcile : Infinity) - Date.now()));
  } while (!stop.signal.aborted);
} finally {
  await db.$disconnect();
}
log({ worker: "stopped" });
// --once: exit 1 if anything failed, for cron and CI. A long-running worker logs failures and keeps going.
process.exitCode = once && failed ? 1 : 0;
