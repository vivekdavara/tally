// Checks StripeProvider against Stripe's real test mode, with your own test key. Not run by the tests or CI, which
// never have a key; the tests check the client against a local stand-in instead.
//
//   STRIPE_SECRET_KEY=sk_test_... npx tsx scripts/stripe-smoke.ts
//
// Creates a checkout session for 0.50 USD (Stripe's minimum), prints its hosted URL, asks for it again with the same
// idempotency key (Stripe must return the same session), then expires it. Moves no money: test mode, and the session
// is expired before anyone could pay it. Then, to see webhooks arrive locally, run the app with BILLING_PROVIDER=stripe
// and the Stripe CLI's `stripe listen --forward-to localhost:8117/api/stripe/webhook` (its whsec_ is
// STRIPE_WEBHOOK_SECRET).
import { randomUUID } from "node:crypto";
import { StripeProvider } from "../src/server/billing/stripe-provider";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.log("STRIPE_SECRET_KEY isn't set: nothing to check (this script needs your Stripe test-mode key).");
  process.exit(0);
}
const stripe = new StripeProvider({ secretKey: key }); // refuses anything but a test-mode key
const request = {
  amountMinor: 50n,
  currency: "USD" as const,
  description: "Tally smoke test (expired at once)",
  customerEmail: "smoke@example.com",
  successUrl: "http://localhost:8117/paid?status=success",
  cancelUrl: "http://localhost:8117/paid?status=canceled",
  metadata: { organization_id: randomUUID(), invoice_id: randomUUID() },
  idempotencyKey: `tally-smoke-${randomUUID()}`,
};
const first = await stripe.createCheckoutSession(request);
console.log(`created ${first.id}, expires ${first.expiresAt.toISOString()}\n  ${first.url}`);
const again = await stripe.createCheckoutSession(request);
console.log(again.id === first.id ? "same idempotency key: same session (as expected)" : `MISMATCH: got ${again.id}`);
await stripe.expireCheckoutSession(first.id);
console.log(`expired ${first.id}`);
if (again.id !== first.id) process.exit(1);
