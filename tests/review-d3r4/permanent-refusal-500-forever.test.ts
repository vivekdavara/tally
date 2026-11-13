// Review D3 round 4: expireSessions now counts every failure as retryable except the codes session_not_open and
// resource_missing, ignoring ProviderError.retryable. A refusal the provider itself marks permanent (retryable =
// false: a 400 invalid_request_error, which is how Stripe refuses to expire a session that isn't open, or the
// client's own bad_request) makes the hook throw on every run, so the paying event is answered 500 on every
// delivery: Stripe redelivers for three days, then gives up (and may disable the endpoint), for an event that was
// applied long ago. Nothing in Tally ever classifies it as done.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { BillingProvider } from "@/server/billing/provider";
import { ProviderError } from "@/server/billing/provider";
import { expireOthersWhenPaid } from "@/server/billing/service";
import { signatureHeader } from "@/server/billing/signature";
import { StripeProvider } from "@/server/billing/stripe-provider";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { markPaid } from "@/server/invoices/service";
import { appDb } from "../helpers";
import { abandonedThenNewer, ok, SECRET } from "../review-d3r2/_setup";

let app: Db;
beforeAll(() => { app = appDb({ max: 4 }); });
afterAll(async () => app.$disconnect());

it("a permanent provider refusal to expire a stale link doesn't keep the paying event at 500 forever", async () => {
  const { provider, run, invoiceId, lateA } = await abandonedThenNewer(app);
  ok(await run((tx) => markPaid(tx, invoiceId)));
  // Stripe refuses the expiry with a 400 (permanent: the same request will get the same answer).
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Only Checkout Sessions with a status in [\"open\"] can be expired." } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  const stripe = new StripeProvider({ secretKey: ["sk", "test", "review0000000000"].join("_"), fetch: fakeFetch });
  const viaStripe: BillingProvider = { name: "mock", createCheckoutSession: (r) => provider.createCheckoutSession(r), expireCheckoutSession: (id) => stripe.expireCheckoutSession(id) };
  // The provider says this failure is permanent.
  const refusal = await stripe.expireCheckoutSession("cs_test_" + "a".repeat(24)).catch((e: unknown) => e);
  expect(refusal instanceof ProviderError && refusal.retryable).toBe(false);
  const deps: WebhookDeps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
    afterApplied: expireOthersWhenPaid(viaStripe, (event) => (fn) => withTenant(event.organizationId, fn, app)),
  };
  const answers: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await handleStripeWebhook(lateA.body, signatureHeader(SECRET, Math.floor(Date.now() / 1000), lateA.body), deps);
    answers.push(r.status);
    if (r.status >= 200 && r.status < 300) break;
  }
  expect({ answers, last: answers.at(-1) }).toMatchObject({ last: 200 });
});
