// Billing end to end below the HTTP layer: payment links for open invoices (startCheckout) and the webhook path
// (handleStripeWebhook: verify, parse, apply in the event's tenant transaction). The mock provider plays Stripe and
// the customer; its signed deliveries are captured here so they can be delivered once, twice, concurrently, late or
// out of order.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockProvider, type SignedDelivery } from "@/server/billing/mock-provider";
import type { BillingProvider, CheckoutRequest } from "@/server/billing/provider";
import { checkoutIdempotencyKey, expireOthersWhenPaid, expirePendingCheckouts, listPayments, startCheckout } from "@/server/billing/service";
import { signatureHeader } from "@/server/billing/signature";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import type { Currency } from "@/server/invoices/money";
import { addLine, createCustomer, createDraft, finalize, markPaid, voidInvoice } from "@/server/invoices/service";
import { adminDb, appDb, unique } from "../helpers";

const SECRET = "whsec_integration_test_secret";
let app: Db;
let admin: Db;
let deps: WebhookDeps;

beforeAll(() => {
  app = appDb({ max: 12 });
  admin = adminDb({ max: 2 });
  deps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
  };
});

afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};

interface Org {
  id: string;
  run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  customerId: string;
}

async function newOrg(): Promise<Org> {
  const org = await app.organization.create({ data: { name: "Acme", slug: `pay-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const customerId = await run(async (tx) => ok(await createCustomer(tx, { name: "Navy Yard", email: `p-${unique()}@navy.example`, address: null })));
  return { id: org.id, run, customerId };
}

/** An OPEN invoice of `unitPriceMinor` (one unit, no tax) in `currency`. */
async function openInvoice(org: Org, unitPriceMinor = 5342n, currency: Currency = "USD"): Promise<string> {
  return org.run(async (tx) => {
    const id = ok(await createDraft(tx, { customerId: org.customerId, currency, memo: null }));
    ok(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor, taxRate: 0n }));
    ok(await finalize(tx, id, 30));
    return id;
  });
}

function mock() {
  const delivered: SignedDelivery[] = [];
  const provider = new MockProvider({ webhookSecret: SECRET, deliver: async (d) => void delivered.push(d) });
  return { provider, delivered };
}

const checkoutDeps = (provider: BillingProvider) => ({ provider, appBaseUrl: "http://localhost:8117", organizationName: "Acme" });
const deliver = (d: SignedDelivery) => handleStripeWebhook(d.body, d.header, deps);
const sessionIdOf = (url: string) => url.split("/").at(-1)!;

async function state(org: Org, invoiceId: string) {
  return org.run(async (tx) => ({
    invoice: (await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } })).status,
    payments: (await listPayments(tx, invoiceId)).map((p) => ({ status: p.status, refundDue: p.refundDue })),
    events: await tx.stripeEvent.findMany({ where: { payment: { invoiceId } }, select: { type: true, outcome: true }, orderBy: { receivedAt: "asc" } }),
  }));
}

describe("startCheckout", () => {
  it("makes one pending payment for the invoice's stored total, and reuses it", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const first = ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)));
    expect(first).toMatchObject({ reused: false });
    expect(first.url).toMatch(/^\/mock-checkout\/cs_mock_/);
    const session = provider.session(sessionIdOf(first.url))!;
    expect(session.request).toMatchObject({
      amountMinor: 5342n,
      currency: "USD",
      description: "Invoice INV-0001 from Acme",
      metadata: { organization_id: org.id, invoice_id: invoiceId },
      successUrl: "http://localhost:8117/paid?status=success",
    });
    expect(session.request.idempotencyKey).toMatch(new RegExp(`^tally-checkout-${invoiceId}-1-[0-9a-f]{16}$`));
    expect(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)))).toEqual({ url: first.url, reused: true });
    expect((await state(org, invoiceId)).payments).toEqual([{ status: "PENDING", refundDue: false }]);
  });

  it("cuts a long description by characters, never through an emoji (it must stay valid UTF-16)", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    // "Invoice INV-0001 from " is 22 characters: the 250th UTF-16 unit falls inside the first emoji.
    const name = `${"a".repeat(227)}😀😀`;
    const { url } = ok(await startCheckout(org.run, invoiceId, { ...checkoutDeps(provider), organizationName: name }));
    const description = provider.session(sessionIdOf(url))!.request.description;
    expect(description.isWellFormed()).toBe(true);
    expect([...description]).toHaveLength(250);
    expect(() => encodeURIComponent(description)).not.toThrow();
  });

  it("refuses a missing, draft, paid or void invoice, and amounts Stripe won't take", async () => {
    const org = await newOrg();
    const { provider } = mock();
    const go = (id: string) => startCheckout(org.run, id, checkoutDeps(provider));
    expect(await go("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, reason: "not-found" });
    expect(await go("not-a-uuid")).toEqual({ ok: false, reason: "not-found" });
    const draft = await org.run(async (tx) => ok(await createDraft(tx, { customerId: org.customerId, currency: "USD", memo: null })));
    expect(await go(draft)).toEqual({ ok: false, reason: "not-open" });
    const paid = await openInvoice(org);
    await org.run((tx) => markPaid(tx, paid));
    expect(await go(paid)).toEqual({ ok: false, reason: "not-open" });
    expect(await go(await openInvoice(org, 49n))).toEqual({ ok: false, reason: "amount-too-small" });
    expect(await go(await openInvoice(org, 100_000_000n))).toEqual({ ok: false, reason: "amount-too-large" });
    expect(await go(await openInvoice(org, 5000n, "KWD"))).toEqual({ ok: false, reason: "currency-not-chargeable" });
  });

  it("gives two clicks at once the same session and one row", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const results = await Promise.all(Array.from({ length: 8 }, () => startCheckout(org.run, invoiceId, checkoutDeps(provider))));
    const urls = new Set(results.map((r) => ok(r).url));
    expect(urls.size).toBe(1);
    expect((await state(org, invoiceId)).payments).toHaveLength(1);
  });

  it("recovers the same session after a crash between the provider call and the insert", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    let calls = 0;
    // The second transaction (the insert) "crashes" on the first attempt.
    const crashingRun: typeof org.run = (fn) => (++calls === 2 ? Promise.reject(new Error("crash")) : org.run(fn));
    await expect(startCheckout(crashingRun, invoiceId, checkoutDeps(provider))).rejects.toThrow("crash");
    expect((await state(org, invoiceId)).payments).toHaveLength(0);
    const retried = ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)));
    // The idempotency key (same invoice, same attempt) returned the session the crashed call created.
    expect(provider.session(sessionIdOf(retried.url))!.request.idempotencyKey).toMatch(new RegExp(`^tally-checkout-${invoiceId}-1-`));
    expect((await state(org, invoiceId)).payments).toHaveLength(1);
  });

  it("isn't stuck when a retry after a crash asks for something else (the organization renamed)", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    let calls = 0;
    const crashingRun: typeof org.run = (fn) => (++calls === 2 ? Promise.reject(new Error("crash")) : org.run(fn));
    await expect(startCheckout(crashingRun, invoiceId, checkoutDeps(provider))).rejects.toThrow("crash");
    // Same invoice, same attempt, different description: under a key without the digest, the provider refused it
    // as a reused key (provider-error) and nothing would change until the key expired.
    const renamed = ok(await startCheckout(org.run, invoiceId, { ...checkoutDeps(provider), organizationName: "Acme Renamed" }));
    expect(provider.session(sessionIdOf(renamed.url))!.request.description).toBe("Invoice INV-0001 from Acme Renamed");
    expect((await state(org, invoiceId)).payments).toHaveLength(1);
  });

  it("expires the new session if the invoice was voided while it was being created", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider, delivered } = mock();
    const racing: BillingProvider = {
      name: "mock",
      async createCheckoutSession(request: CheckoutRequest) {
        await org.run((tx) => voidInvoice(tx, invoiceId));
        return provider.createCheckoutSession(request);
      },
      expireCheckoutSession: (id) => provider.expireCheckoutSession(id),
    };
    expect(await startCheckout(org.run, invoiceId, checkoutDeps(racing))).toEqual({ ok: false, reason: "not-open" });
    expect(delivered.map((d) => d.type)).toEqual(["checkout.session.expired"]);
    expect((await state(org, invoiceId)).payments).toHaveLength(0);
  });

  it("ends a pending session well past its expiry and starts attempt 2; refuses within the grace period", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    // A provider whose clock is 24 h + 10 min behind: its sessions are created already 10 minutes expired.
    const now = () => Math.floor(Date.now() / 1000);
    let skew = 86_400 + 600;
    const old = new MockProvider({ webhookSecret: SECRET, now: () => now() - skew });
    ok(await startCheckout(org.run, invoiceId, checkoutDeps(old)));
    const second = ok(await startCheckout(org.run, invoiceId, checkoutDeps(old)));
    expect(second.reused).toBe(false);
    expect(old.session(sessionIdOf(second.url))!.request.idempotencyKey).toMatch(new RegExp(`^tally-checkout-${invoiceId}-2-`));
    expect((await state(org, invoiceId)).payments.map((p) => p.status).sort()).toEqual(["EXPIRED", "PENDING"]);
    // Expired two minutes ago: inside the grace period it might still complete at Stripe, so no new link yet.
    const org2 = await newOrg();
    const invoice2 = await openInvoice(org2);
    skew = 86_400 + 120;
    ok(await startCheckout(org2.run, invoice2, checkoutDeps(old)));
    expect(await startCheckout(org2.run, invoice2, checkoutDeps(old))).toEqual({ ok: false, reason: "checkout-expiring" });
  });
});

describe("webhook events", () => {
  async function paidByCard() {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider, delivered } = mock();
    const { url } = ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)));
    const delivery = await provider.pay(sessionIdOf(url));
    return { org, invoiceId, provider, delivered, delivery, sessionId: sessionIdOf(url) };
  }

  it("a card payment pays the invoice, records the money and the event", async () => {
    const { org, invoiceId, delivery } = await paidByCard();
    expect(await deliver(delivery)).toEqual({ status: 200, body: { result: "processed", outcome: "invoice-paid" } });
    expect(await state(org, invoiceId)).toEqual({
      invoice: "PAID",
      payments: [{ status: "SUCCEEDED", refundDue: false }],
      events: [{ type: "checkout.session.completed", outcome: "invoice-paid" }],
    });
    const payment = await org.run((tx) => tx.payment.findFirstOrThrow({ where: { invoiceId } }));
    expect(payment.paymentIntentId).toMatch(/^pi_mock_/);
    // Every stored time is the provider's, to the second (the event's `created`, the session's expires_at).
    const event = JSON.parse(delivery.body.toString());
    expect(payment.paidAt!.getTime()).toBe(event.created * 1000);
    expect(payment.expiresAt.getTime()).toBe(event.data.object.expires_at * 1000);
    const stored = await org.run((tx) => tx.stripeEvent.findUniqueOrThrow({ where: { id: event.id } }));
    expect(stored.stripeCreatedAt.getTime()).toBe(event.created * 1000);
  });

  it("takes effect once however often it's delivered, even 10 times at once", async () => {
    const { org, invoiceId, delivery } = await paidByCard();
    const answers = await Promise.all(Array.from({ length: 10 }, () => deliver(delivery)));
    const results = answers.map((a) => a.body.result).sort();
    expect(results).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "duplicate", "processed"]);
    expect(await deliver(delivery)).toEqual({ status: 200, body: { result: "duplicate" } });
    expect((await state(org, invoiceId)).events).toHaveLength(1);
  });

  it("follows a bank debit: processing, then paid", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    expect((await deliver(await provider.pay(id, "bank"))).body.outcome).toBe("payment-processing");
    expect((await state(org, invoiceId)).invoice).toBe("OPEN");
    expect((await deliver(await provider.settle(id, true))).body.outcome).toBe("invoice-paid");
    expect((await state(org, invoiceId)).payments).toEqual([{ status: "SUCCEEDED", refundDue: false }]);
  });

  it("can't be undone by events arriving out of order", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    const completed = await provider.pay(id, "bank");
    const succeeded = await provider.settle(id, true);
    const failedLater = provider.event("checkout.session.async_payment_failed", provider.session(id)!);
    // Settlement first, then the older "completed (unpaid)", then a failure: neither moves it back.
    expect((await deliver(succeeded)).body.outcome).toBe("invoice-paid");
    expect((await deliver(completed)).body.outcome).toBe("stale");
    expect((await deliver(failedLater)).body.outcome).toBe("stale");
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "PAID", payments: [{ status: "SUCCEEDED" }] });
  });

  it("a failed bank debit leaves the invoice open for a new attempt", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    await deliver(await provider.pay(id, "bank"));
    expect((await deliver(await provider.settle(id, false))).body.outcome).toBe("payment-failed");
    const again = ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)));
    expect(again.reused).toBe(false);
    expect(provider.session(sessionIdOf(again.url))!.request.idempotencyKey).toMatch(new RegExp(`^tally-checkout-${invoiceId}-2-`));
  });

  it("an expired session ends the attempt; a late success still pays the invoice", async () => {
    const { org, invoiceId, provider, sessionId } = await paidByCard();
    // The expiry arrives first (delivered out of order), then the payment made just before it.
    const expired = provider.event("checkout.session.expired", { ...provider.session(sessionId)!, status: "expired", paymentStatus: "unpaid", paymentIntent: null });
    expect((await deliver(expired)).body.outcome).toBe("payment-expired");
    const paid = provider.event("checkout.session.completed", provider.session(sessionId)!);
    expect((await deliver(paid)).body.outcome).toBe("invoice-paid");
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "PAID", payments: [{ status: "SUCCEEDED", refundDue: false }] });
  });

  it("a late success on an abandoned attempt expires the invoice's newer link", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const delivered: SignedDelivery[] = [];
    let skew = 86_400 + 600;
    const provider = new MockProvider({ webhookSecret: SECRET, now: () => Math.floor(Date.now() / 1000) - skew, deliver: async (d) => void delivered.push(d) });
    const a = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    skew = 0;
    // A is past its expiry, so this marks it EXPIRED and makes B.
    const b = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    const withHook: WebhookDeps = { ...deps, afterApplied: expireOthersWhenPaid(provider, (event) => (fn) => withTenant(event.organizationId, fn, app)) };
    const lateA = provider.event("checkout.session.completed", { ...provider.session(a)!, status: "complete", paymentStatus: "paid", paymentIntent: "pi_mock_late" });
    expect((await handleStripeWebhook(lateA.body, lateA.header, withHook)).body.outcome).toBe("invoice-paid");
    // B was expired at the provider, and its expiry event marks it.
    expect(provider.session(b)!.status).toBe("expired");
    const expiredB = delivered.find((d) => d.type === "checkout.session.expired")!;
    expect((await deliver(expiredB)).body.outcome).toBe("payment-expired");
    expect((await state(org, invoiceId)).payments.map((p) => p.status).sort()).toEqual(["EXPIRED", "SUCCEEDED"]);
  });

  it("money for an invoice already paid by hand is recorded and flagged for a refund", async () => {
    const { org, invoiceId, delivery } = await paidByCard();
    await org.run((tx) => markPaid(tx, invoiceId));
    expect((await deliver(delivery)).body.outcome).toBe("refund-due-paid");
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "PAID", payments: [{ status: "SUCCEEDED", refundDue: true }] });
  });

  it("money for a voided invoice is recorded and flagged; the invoice stays void", async () => {
    const { org, invoiceId, delivery } = await paidByCard();
    await org.run((tx) => voidInvoice(tx, invoiceId));
    expect((await deliver(delivery)).body.outcome).toBe("refund-due-void");
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "VOID", payments: [{ status: "SUCCEEDED", refundDue: true }] });
  });

  it("an amount that differs from the payment's flags a refund and leaves the invoice open", async () => {
    const { org, invoiceId, provider, sessionId } = await paidByCard();
    const s = provider.session(sessionId)!;
    const wrong = provider.event("checkout.session.completed", { ...s, request: { ...s.request, amountMinor: 1n } });
    expect((await deliver(wrong)).body.outcome).toBe("amount-mismatch");
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "OPEN", payments: [{ status: "SUCCEEDED", refundDue: true }] });
  });

  it("two different success events for one payment pay the invoice once", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    await deliver(await provider.pay(id, "bank"));
    const a = await provider.settle(id, true);
    const b = provider.event("checkout.session.async_payment_succeeded", provider.session(id)!);
    const outcomes = (await Promise.all([deliver(a), deliver(b)])).map((r) => r.body.outcome).sort();
    expect(outcomes).toEqual(["already-succeeded", "invoice-paid"]);
  });

  it("voiding expires the pending session; its expiry event marks the payment", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider, delivered } = mock();
    ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)));
    await org.run((tx) => voidInvoice(tx, invoiceId));
    expect(await expirePendingCheckouts(org.run, invoiceId, provider)).toEqual({ expired: 1, retryable: [] });
    expect((await deliver(delivered.at(-1)!)).body.outcome).toBe("payment-expired");
    expect((await state(org, invoiceId)).payments).toEqual([{ status: "EXPIRED", refundDue: false }]);
  });

  it("leaves an outcome on every processed event", async () => {
    const nulls = await admin.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM stripe_events WHERE outcome IS NULL`;
    expect(nulls[0]!.n).toBe(0n);
  });
});

describe("webhook requests that don't apply", () => {
  it("refuses a bad signature (400) and stores nothing", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    const d = await provider.pay(id);
    // Change the signature's first hex digit to a different one (replacing it with a fixed digit was a no-op 1 run in 16).
    const tampered = d.header.replace(/v1=(.)/, (_m, c: string) => `v1=${c === "0" ? "1" : "0"}`);
    expect(tampered).not.toBe(d.header);
    expect(await handleStripeWebhook(d.body, tampered, deps)).toMatchObject({ status: 400, body: { result: "rejected" } });
    expect(await handleStripeWebhook(d.body, null, deps)).toMatchObject({ status: 400 });
    expect(await handleStripeWebhook(d.body, d.header, { ...deps, secret: "whsec_other" })).toMatchObject({ status: 400 });
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "OPEN", events: [] });
  });

  const signed = (body: unknown) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return { bytes, header: signatureHeader(SECRET, Math.floor(Date.now() / 1000), bytes) };
  };

  it("acknowledges authentic events it doesn't act on (200, ignored)", async () => {
    const event = (type: string, object: unknown, livemode = false) => ({ id: `evt_test_${unique()}`, object: "event", type, created: 1_763_049_600, livemode, data: { object } });
    const session = { id: "cs_test_x", object: "checkout.session", amount_total: 100, currency: "usd", payment_status: "paid", metadata: {} };
    for (const [body, reason] of [
      [event("customer.created", { id: "cus_1", object: "customer" }), "unhandled-type"],
      [event("checkout.session.completed", session), "not-a-tally-session"],
      [event("checkout.session.completed", { ...session, metadata: { organization_id: "x", invoice_id: "y" } }), "not-a-tally-session"],
      [event("checkout.session.completed", session, true), "live-mode"],
    ] as const) {
      const { bytes, header } = signed(body);
      expect(await handleStripeWebhook(bytes, header, deps)).toEqual({ status: 200, body: { result: "ignored", reason } });
    }
  });

  it("refuses a signed body that isn't an event, or a handled event it can't read (400: Stripe retries)", async () => {
    for (const body of [[1, 2], { id: "evt_x", object: "charge" }, { id: "evt_test_1", object: "event", type: "checkout.session.completed", created: 1, livemode: false, data: { object: { id: "cs_x", object: "checkout.session" } } }]) {
      const { bytes, header } = signed(body);
      expect((await handleStripeWebhook(bytes, header, deps)).status).toBe(400);
    }
    const raw = Buffer.from("not json");
    expect(await handleStripeWebhook(raw, signatureHeader(SECRET, Math.floor(Date.now() / 1000), raw), deps)).toEqual({ status: 400, body: { result: "rejected", reason: "body is not JSON" } });
  });

  it("can't touch another organization's payment by naming it in the metadata", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const invoiceB = await openInvoice(b);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(b.run, invoiceB, checkoutDeps(provider))).url);
    const s = provider.session(id)!;
    // b's session, but the event says it's a's: under a's row security the session doesn't exist.
    const crossed = provider.event("checkout.session.completed", { ...s, status: "complete", paymentStatus: "paid", request: { ...s.request, metadata: { organization_id: a.id, invoice_id: invoiceB } } });
    expect(await deliver(crossed)).toEqual({ status: 404, body: { result: "unknown-session" } });
    expect(await state(b, invoiceB)).toMatchObject({ invoice: "OPEN", payments: [{ status: "PENDING" }], events: [] });
    expect(await a.run((tx) => tx.stripeEvent.count())).toBe(0);
  });

  it("asks for a retry (404) for a session not stored yet, and applies the retry once it is", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    // A session created at the provider whose row isn't in the database yet.
    const request = {
      amountMinor: 5342n,
      currency: "USD" as const,
      description: "Invoice INV-0001 from Acme",
      customerEmail: (await org.run((tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } }))).billToEmail!,
      successUrl: "http://localhost:8117/paid?status=success",
      cancelUrl: "http://localhost:8117/paid?status=canceled",
      metadata: { organization_id: org.id, invoice_id: invoiceId },
    };
    const session = await provider.createCheckoutSession({ ...request, idempotencyKey: checkoutIdempotencyKey(invoiceId, 1, request) });
    const early = await provider.pay(session.id);
    expect(await deliver(early)).toEqual({ status: 404, body: { result: "unknown-session" } });
    expect((await state(org, invoiceId)).events).toEqual([]);
    // startCheckout's idempotency key finds the same session and stores it; Stripe's retry then applies.
    ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider)));
    expect((await deliver(early)).body).toEqual({ result: "processed", outcome: "invoice-paid" });
  });

  it("acknowledges events for a deleted organization", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    const d = await provider.pay(id);
    await admin.$executeRaw`DELETE FROM organizations WHERE id = ${org.id}::uuid`;
    expect(await deliver(d)).toEqual({ status: 200, body: { result: "ignored", reason: "organization-gone" } });
  });

  it("answers 500 and stores nothing when processing fails, so Stripe retries", async () => {
    const org = await newOrg();
    const invoiceId = await openInvoice(org);
    const { provider } = mock();
    const id = sessionIdOf(ok(await startCheckout(org.run, invoiceId, checkoutDeps(provider))).url);
    const d = await provider.pay(id);
    const failing: WebhookDeps = { ...deps, run: (event, fn) => withTenant(event.organizationId, async (tx) => {
      await fn(tx);
      throw new Error("database went away");
    }, app) };
    expect(await handleStripeWebhook(d.body, d.header, failing)).toEqual({ status: 500, body: { result: "error" } });
    expect(await state(org, invoiceId)).toMatchObject({ invoice: "OPEN", events: [] });
    expect((await deliver(d)).body.outcome).toBe("invoice-paid");
  });
});
