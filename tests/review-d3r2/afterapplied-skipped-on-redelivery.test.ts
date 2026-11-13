// Review D3 round 2: afterApplied (868b60c) runs only on the delivery whose transaction applied the event. If that
// process dies after COMMIT but before the hook finishes (a deploy, an OOM kill, a Stripe call hanging past
// Stripe's webhook timeout), Stripe gets no 2xx and redelivers; the redelivery is "duplicate", which returns
// before afterApplied. The invoice is PAID and its newer link B stays open: the customer can pay twice.
import { afterAll, beforeAll, expect, it } from "vitest";
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

it("a redelivered paying event still expires the invoice's newer link when the first delivery died after COMMIT", async () => {
  const { provider, b, lateA } = await abandonedThenNewer(app);
  const base: WebhookDeps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
  };
  const withHook: WebhookDeps = { ...base, afterApplied: expireOthersWhenPaid(provider, (event) => (fn) => withTenant(event.organizationId, fn, app)) };
  // First delivery: the transaction commits, then the process dies inside afterApplied (it never returns, so no
  // answer reaches Stripe).
  const dying: WebhookDeps = { ...withHook, afterApplied: () => new Promise<void>(() => {}) };
  const first = await Promise.race([handleStripeWebhook(lateA.body, lateA.header, dying), new Promise<"no answer">((r) => setTimeout(() => r("no answer"), 500))]);
  expect(first).toBe("no answer");
  // Stripe's retry, to a fresh process: same event id and body, re-signed.
  const retry = await handleStripeWebhook(lateA.body, signatureHeader(SECRET, Math.floor(Date.now() / 1000), lateA.body), withHook);
  expect(retry.status).toBe(200);
  // B must not stay payable once the invoice is paid.
  expect(provider.session(b)!.status).toBe("expired");
});
