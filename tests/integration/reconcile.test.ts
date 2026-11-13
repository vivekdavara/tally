// Reconciliation (src/server/billing/reconcile.ts): after an outage that lost webhook deliveries, replaying the
// provider's event log applies what was missed, exactly once, in order; running it again changes nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, type SignedDelivery } from "@/server/billing/mock-provider";
import { reconcileEvents } from "@/server/billing/reconcile";
import { expireOthersWhenPaid, startCheckout } from "@/server/billing/service";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import { appDb, unique } from "../helpers";

const SECRET = "whsec_reconcile_test_secret";
let app: Db;
let deps: Omit<WebhookDeps, "secret" | "now">;

beforeAll(() => {
  app = appDb({ max: 6 });
  deps = {
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
  };
});

afterAll(async () => {
  await app.$disconnect();
});

const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};

async function openInvoice() {
  const org = await app.organization.create({ data: { name: "Acme", slug: `rec-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const invoiceId = await run(async (tx) => {
    const customerId = ok(await createCustomer(tx, { name: "N", email: `p-${unique()}@navy.example`, address: null }));
    const id = ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
    ok(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor: 5342n, taxRate: 0n }));
    ok(await finalize(tx, id, 30));
    return id;
  });
  const status = () => run(async (tx) => ({
    invoice: (await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } })).status,
    payments: (await tx.payment.findMany({ where: { invoiceId }, select: { status: true } })).map((p) => p.status).sort(),
    events: await tx.stripeEvent.count(),
  }));
  return { org, run, invoiceId, status };
}

/** A mock whose webhook deliveries are lost (the endpoint is down) unless `up` is set. */
function provider(now?: () => number) {
  const state = { up: false };
  const delivered: SignedDelivery[] = [];
  const mock = new MockProvider({
    webhookSecret: SECRET,
    now,
    deliver: async (d) => {
      if (!state.up) return;
      delivered.push(d);
      await handleStripeWebhook(d.body, d.header, { ...deps, secret: SECRET });
    },
  });
  return { mock, state, delivered };
}

const checkout = { appBaseUrl: "http://localhost:8117", organizationName: "Acme" };
const sessionIdOf = (url: string) => url.split("/").at(-1)!;
const since = new Date(Date.now() - 3_600_000);

describe("reconcileEvents", () => {
  it("applies a payment whose webhook was lost, and changes nothing when run again", async () => {
    const inv = await openInvoice();
    const { mock } = provider();
    await mock.pay(sessionIdOf(ok(await startCheckout(inv.run, inv.invoiceId, { provider: mock, ...checkout })).url));
    expect(await inv.status()).toEqual({ invoice: "OPEN", payments: ["PENDING"], events: 0 });
    expect(await reconcileEvents(mock, since, deps)).toEqual({ fetched: 1, processed: 1, duplicate: 0, ignored: 0, notApplied: [], afterEffectsFailed: [] });
    expect(await inv.status()).toEqual({ invoice: "PAID", payments: ["SUCCEEDED"], events: 1 });
    expect(await reconcileEvents(mock, since, deps)).toEqual({ fetched: 1, processed: 0, duplicate: 1, ignored: 0, notApplied: [], afterEffectsFailed: [] });
    expect(await inv.status()).toEqual({ invoice: "PAID", payments: ["SUCCEEDED"], events: 1 });
  });

  it("replays a bank debit's two lost events in order: processing, then paid", async () => {
    const inv = await openInvoice();
    const { mock } = provider();
    const id = sessionIdOf(ok(await startCheckout(inv.run, inv.invoiceId, { provider: mock, ...checkout })).url);
    await mock.pay(id, "bank");
    await mock.settle(id, true);
    const report = await reconcileEvents(mock, since, deps);
    expect(report).toMatchObject({ fetched: 2, processed: 2, notApplied: [], afterEffectsFailed: [] });
    const outcomes = await inv.run((tx) => tx.stripeEvent.findMany({ orderBy: { receivedAt: "asc" }, select: { outcome: true } }));
    expect(outcomes.map((o) => o.outcome)).toEqual(["payment-processing", "invoice-paid"]);
  });

  it("only applies what the webhook missed when some deliveries got through", async () => {
    const a = await openInvoice();
    const b = await openInvoice();
    const { mock, state } = provider();
    const sa = sessionIdOf(ok(await startCheckout(a.run, a.invoiceId, { provider: mock, ...checkout })).url);
    const sb = sessionIdOf(ok(await startCheckout(b.run, b.invoiceId, { provider: mock, ...checkout })).url);
    state.up = true;
    await mock.pay(sa); // delivered
    state.up = false;
    await mock.pay(sb); // lost
    expect((await a.status()).invoice).toBe("PAID");
    expect((await b.status()).invoice).toBe("OPEN");
    expect(await reconcileEvents(mock, since, deps)).toMatchObject({ fetched: 2, processed: 1, duplicate: 1 });
    expect((await b.status()).invoice).toBe("PAID");
  });

  it("runs the after-effects too: a lost late success still expires the invoice's newer link", async () => {
    const inv = await openInvoice();
    let skew = 86_400 + 600;
    const { mock } = provider(() => Math.floor(Date.now() / 1000) - skew);
    const a = sessionIdOf(ok(await startCheckout(inv.run, inv.invoiceId, { provider: mock, ...checkout })).url);
    skew = 0;
    const b = sessionIdOf(ok(await startCheckout(inv.run, inv.invoiceId, { provider: mock, ...checkout })).url);
    // A's late success is in the provider's log but was never delivered; the forged event is pushed into the log by
    // paying A through a fresh session object (the mock won't pay an expired session itself).
    const lateA = mock.event("checkout.session.completed", { ...mock.session(a)!, status: "complete", paymentStatus: "paid", paymentIntent: "pi_mock_late" });
    const source = { listEvents: async () => [JSON.parse(lateA.body.toString())] };
    const withHook = { ...deps, afterApplied: expireOthersWhenPaid(mock, (event) => (fn) => withTenant(event.organizationId, fn, app)) };
    expect(await reconcileEvents(source, since, withHook)).toMatchObject({ processed: 1, notApplied: [], afterEffectsFailed: [] });
    expect(mock.session(b)!.status).toBe("expired");
  });

  it("leaves what it can't apply for the next run, and skips events before `since`", async () => {
    const inv = await openInvoice();
    const { mock } = provider();
    // A session the provider has but Tally never stored: 404, not applied, retried next time.
    const stray = await mock.createCheckoutSession({
      amountMinor: 5342n,
      currency: "USD",
      description: "x",
      customerEmail: "x@example.com",
      successUrl: "http://localhost:8117/paid",
      cancelUrl: "http://localhost:8117/paid",
      metadata: { organization_id: inv.org.id, invoice_id: inv.invoiceId },
      idempotencyKey: `stray-${unique()}`,
    });
    const d = await mock.pay(stray.id);
    expect(await reconcileEvents(mock, since, deps)).toEqual({ fetched: 1, processed: 0, duplicate: 0, ignored: 0, notApplied: [{ eventId: d.eventId, status: 404, result: "unknown-session" }], afterEffectsFailed: [] });
    expect(await reconcileEvents(mock, new Date(Date.now() + 60_000), deps)).toMatchObject({ fetched: 0 });
  });
});
