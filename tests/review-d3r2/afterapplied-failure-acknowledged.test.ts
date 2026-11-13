// Review D3 round 2: when expiring the newer link fails transiently (Stripe 5xx/429/timeout), expirePendingCheckouts
// logs and swallows the error and the webhook answers 200 "processed", so Stripe never retries; nothing else ever
// retries the expiry either (a redelivery would be "duplicate"). The invoice is PAID and link B stays payable.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { BillingProvider } from "@/server/billing/provider";
import { ProviderError } from "@/server/billing/provider";
import { expireOthersWhenPaid } from "@/server/billing/service";
import { signatureHeader } from "@/server/billing/signature";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb } from "../helpers";
import { abandonedThenNewer, SECRET } from "./_setup";

let app: Db;
beforeAll(() => { app = appDb({ max: 4 }); });
afterAll(async () => app.$disconnect());

it("a transient failure expiring the newer link is retried (Stripe redelivers until a 2xx)", async () => {
  const { provider, b, lateA } = await abandonedThenNewer(app);
  let failures = 1;
  const flaky: BillingProvider = {
    name: "mock",
    createCheckoutSession: (r) => provider.createCheckoutSession(r),
    async expireCheckoutSession(id) {
      if (failures-- > 0) throw new ProviderError("Stripe request failed: TimeoutError", "network", true);
      return provider.expireCheckoutSession(id);
    },
  };
  const deps: WebhookDeps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
    afterApplied: expireOthersWhenPaid(flaky, (event) => (fn) => withTenant(event.organizationId, fn, app)),
  };
  // Stripe: deliver, and redeliver (same id and body, re-signed) until a 2xx, three tries here.
  const answers: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await handleStripeWebhook(lateA.body, signatureHeader(SECRET, Math.floor(Date.now() / 1000), lateA.body), deps);
    answers.push(r.status);
    if (r.status >= 200 && r.status < 300) break;
  }
  expect({ answers, b: provider.session(b)!.status }).toMatchObject({ b: "expired" });
});
