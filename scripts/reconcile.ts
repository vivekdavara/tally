// Reconciliation against Stripe (DESIGN.md, "Reconciliation"): applies every checkout-session event Stripe created
// since a point in time, through the same path a webhook delivery takes, for deliveries that never arrived (an outage
// longer than Stripe's retries). Safe to run any number of times: an event already applied is a duplicate.
//
//   BILLING_PROVIDER=stripe STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
//     DATABASE_URL=postgresql://tally_app@localhost:5432/tally npx tsx scripts/reconcile.ts [hours, default 72]
//
// Stripe mode only: the mock provider's event log lives in the server process that sent the events, so there is
// nothing to fetch from here (tests/integration/reconcile.test.ts runs it in-process against the mock). Prints a JSON
// report; exits 1 if any event couldn't be applied, or was applied but its after-effects failed (both are tried again
// on the next run).
import { readBillingConfig } from "../src/server/billing/config";
import { reconcileEvents } from "../src/server/billing/reconcile";
import { expireOthersWhenPaid } from "../src/server/billing/service";
import { StripeProvider } from "../src/server/billing/stripe-provider";
import { createDb } from "../src/server/db/client";
import { assertSafeAppRole } from "../src/server/db/role-check";
import { withTenant } from "../src/server/db/tenant";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

const config = readBillingConfig();
if (config.provider !== "stripe") {
  console.error("reconcile: needs BILLING_PROVIDER=stripe (the mock's event log lives in the server process).");
  process.exit(2);
}
const hours = Number(process.argv[2] ?? 72);
if (!Number.isFinite(hours) || hours <= 0 || hours > 30 * 24) {
  console.error("reconcile: hours must be between 0 and 720 (Stripe keeps events for 30 days)");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("reconcile: DATABASE_URL is not set");
  process.exit(2);
}
const db = createDb(url, { max: 2 });
try {
  // The same refusal as the server's: never run as a role that row-level security doesn't bind.
  await assertSafeAppRole(db);
  const stripe = new StripeProvider({ secretKey: config.stripeSecretKey! });
  const report = await reconcileEvents(stripe, new Date(Date.now() - hours * 3_600_000), {
    run: (event, fn) => withTenant(event.organizationId, fn, db),
    organizationExists: async (id) => (await db.organization.count({ where: { id } })) === 1,
    afterApplied: expireOthersWhenPaid(stripe, (event) => (fn) => withTenant(event.organizationId, fn, db)),
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.notApplied.length > 0 || report.afterEffectsFailed.length > 0) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
