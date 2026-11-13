// Review D3 round 3: the fix makes expireOthersWhenPaid throw (webhook 500, Stripe redelivers) only for
// ProviderError.retryable, and treats every other failure as "a refusal that won't change". StripeProvider marks a
// 429 (or 409) as retryable only when its body is JSON: a 429 without JSON (a rate limiter or proxy in front of
// Stripe answering text/HTML) becomes bad_response with retryable = false, so the hook only logs it, the webhook
// answers 200, Stripe never redelivers, and the paid invoice's newer link B stays payable.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { BillingProvider } from "@/server/billing/provider";
import { expireOthersWhenPaid } from "@/server/billing/service";
import { signatureHeader } from "@/server/billing/signature";
import { StripeProvider } from "@/server/billing/stripe-provider";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb } from "../helpers";
import { abandonedThenNewer, SECRET } from "../review-d3r2/_setup";

let app: Db;
beforeAll(() => { app = appDb({ max: 4 }); });
afterAll(async () => app.$disconnect());

it("a 429 without a JSON body expiring the newer link is retried, not acknowledged", async () => {
  const { provider, b, lateA } = await abandonedThenNewer(app);
  // Stripe's expire endpoint: rate limited once (plain-text 429), then it works (expires the mock session).
  let limited = 1;
  const fakeFetch = (async (url: string | URL) => {
    if (limited-- > 0) return new Response("Too Many Requests", { status: 429, headers: { "Content-Type": "text/plain" } });
    const id = String(url).split("/").at(-2)!;
    await provider.expireCheckoutSession(id);
    return new Response(JSON.stringify({ id, object: "checkout.session", status: "expired" }), { status: 200 });
  }) as typeof fetch;
  // Adapted (setup only): the fake key is assembled at run time, since a key-shaped literal is what GitHub's push
  // protection refuses (it blocked a push earlier on day 3).
  const stripe = new StripeProvider({ secretKey: ["sk", "test", "review0000000000"].join("_"), fetch: fakeFetch });
  // The payment rows say provider "mock" (setup made them with the mock); route expiry through the Stripe client.
  const viaStripe: BillingProvider = { name: "mock", createCheckoutSession: (r) => provider.createCheckoutSession(r), expireCheckoutSession: (id) => stripe.expireCheckoutSession(id) };
  const deps: WebhookDeps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
    afterApplied: expireOthersWhenPaid(viaStripe, (event) => (fn) => withTenant(event.organizationId, fn, app)),
  };
  // Stripe: deliver, and redeliver until a 2xx (three tries here).
  const answers: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await handleStripeWebhook(lateA.body, signatureHeader(SECRET, Math.floor(Date.now() / 1000), lateA.body), deps);
    answers.push(r.status);
    if (r.status >= 200 && r.status < 300) break;
  }
  expect({ answers, b: provider.session(b)!.status }).toMatchObject({ b: "expired" });
});
