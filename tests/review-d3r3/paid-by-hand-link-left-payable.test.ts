// Review D3 round 3: the fix guarantees a paying webhook won't be acknowledged while the invoice keeps a payable
// link, but only for outcome "invoice-paid". When the invoice was marked paid by hand (closeInvoice), its expiry of
// link B is still best effort: a transient provider failure is logged, closeInvoice ignores the new `retryable`
// list, and nothing retries it. A later paying event (A's late success) is then "refund-due-paid", for which
// expireOthersWhenPaid does nothing, so the webhook answers 200 and the PAID invoice keeps payable link B. The
// customer can pay twice (two refunds now: A's and B's).
import { afterAll, beforeAll, expect, it } from "vitest";
import type { BillingProvider } from "@/server/billing/provider";
import { ProviderError } from "@/server/billing/provider";
import { expireOthersWhenPaid, expirePendingCheckouts } from "@/server/billing/service";
import { signatureHeader } from "@/server/billing/signature";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { markPaid } from "@/server/invoices/service";
import { appDb } from "../helpers";
import { abandonedThenNewer, ok, SECRET } from "../review-d3r2/_setup";

let app: Db;
beforeAll(() => { app = appDb({ max: 4 }); });
afterAll(async () => app.$disconnect());

it("after mark-paid's expiry of the newer link failed transiently, a later paying event still ends that link", async () => {
  const { provider, run, invoiceId, b, lateA } = await abandonedThenNewer(app);
  let failures = 1;
  const flaky: BillingProvider = {
    name: "mock",
    createCheckoutSession: (r) => provider.createCheckoutSession(r),
    async expireCheckoutSession(id) {
      if (failures-- > 0) throw new ProviderError("Stripe request failed: TimeoutError", "network", true);
      return provider.expireCheckoutSession(id);
    },
  };
  // closeInvoice(markPaidAction): mark paid, then expirePendingCheckouts, whose result it ignores.
  ok(await run((tx) => markPaid(tx, invoiceId)));
  const closed = await expirePendingCheckouts(run, invoiceId, flaky);
  expect(closed.retryable).toEqual([b]);
  const deps: WebhookDeps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
    afterApplied: expireOthersWhenPaid(flaky, (event) => (fn) => withTenant(event.organizationId, fn, app)),
  };
  // A's late success arrives (and is redelivered until a 2xx).
  const answers: { status: number; outcome?: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await handleStripeWebhook(lateA.body, signatureHeader(SECRET, Math.floor(Date.now() / 1000), lateA.body), deps);
    answers.push({ status: r.status, outcome: r.body.outcome });
    if (r.status >= 200 && r.status < 300) break;
  }
  const invoice = await run((tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } }));
  // The invoice is PAID and the webhook said 2xx: B must not still be payable.
  expect({ invoice: invoice.status, answers, b: provider.session(b)!.status }).toMatchObject({ invoice: "PAID", b: "expired" });
});
