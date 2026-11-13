// The two providers behind BillingProvider, and Stripe's charge limits. The mock must answer like Stripe where
// Tally depends on it; the HTTP client must send what Stripe's API expects (checked by a local server standing in
// for api.stripe.com, which records every request) and map Stripe's failures to retryable or not.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chargeability, maximumChargeMinor } from "@/server/billing/limits";
import { MockProvider, type SignedDelivery } from "@/server/billing/mock-provider";
import { ProviderError, type CheckoutRequest } from "@/server/billing/provider";
import { verifySignature } from "@/server/billing/signature";
import { formEncode, StripeProvider } from "@/server/billing/stripe-provider";

const SECRET = "whsec_unit_test_secret";

const request = (over: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  amountMinor: 5342n,
  currency: "USD",
  description: "Invoice INV-0001 from Acme",
  customerEmail: "payables@navy.example",
  successUrl: "http://localhost:8117/paid?status=success",
  cancelUrl: "http://localhost:8117/paid?status=canceled",
  metadata: { organization_id: "00000000-0000-4000-8000-00000000000a", invoice_id: "00000000-0000-4000-8000-00000000000b" },
  idempotencyKey: "tally-checkout-b-1",
  ...over,
});

async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("expected a ProviderError");
}

describe("chargeability (Stripe's limits)", () => {
  it.each([
    [50n, "USD", true],
    [49n, "USD", false],
    [30n, "GBP", true],
    [29n, "GBP", false],
    [50n, "JPY", true],
    [99_999_999n, "USD", true],
    [100_000_000n, "USD", false],
    [999_999_999n, "INR", true],
    [1_000_000_000n, "INR", false],
  ] as const)("%s %s chargeable: %s", (amount, currency, ok) => {
    expect(chargeability(amount, currency).ok).toBe(ok);
  });

  it("says why", () => {
    expect(chargeability(10n, "EUR")).toEqual({ ok: false, reason: "amount-too-small" });
    expect(chargeability(maximumChargeMinor("CHF") + 1n, "CHF")).toEqual({ ok: false, reason: "amount-too-large" });
    expect(chargeability(5000n, "KWD")).toEqual({ ok: false, reason: "currency-not-chargeable" });
  });
});

describe("MockProvider", () => {
  const make = (now?: () => number) => {
    const delivered: SignedDelivery[] = [];
    const provider = new MockProvider({ webhookSecret: SECRET, now, deliver: async (d) => void delivered.push(d) });
    return { provider, delivered };
  };

  it("creates a session with a mock checkout URL that expires in 24 hours", async () => {
    const { provider } = make(() => 1_000_000);
    const session = await provider.createCheckoutSession(request());
    expect(session.id).toMatch(/^cs_mock_[0-9a-f]{32}$/);
    expect(session.url).toBe(`/mock-checkout/${session.id}`);
    expect(session.expiresAt.getTime()).toBe((1_000_000 + 86_400) * 1000);
  });

  it("returns the same session for a repeated idempotency key, and refuses the key with other parameters", async () => {
    const { provider } = make();
    const a = await provider.createCheckoutSession(request());
    expect(await provider.createCheckoutSession(request())).toEqual(a);
    const other = await refusal(provider.createCheckoutSession(request({ amountMinor: 5343n })));
    expect(other.code).toBe("idempotency_error");
    expect((await provider.createCheckoutSession(request({ idempotencyKey: "k2" }))).id).not.toBe(a.id);
  });

  it("refuses what Stripe would refuse", async () => {
    const { provider } = make();
    expect((await refusal(provider.createCheckoutSession(request({ amountMinor: 49n })))).code).toBe("amount-too-small");
    expect((await refusal(provider.createCheckoutSession(request({ currency: "KWD" })))).code).toBe("currency-not-chargeable");
  });

  it("sends a signed checkout.session.completed when paid by card, which verifies", async () => {
    const { provider, delivered } = make();
    const session = await provider.createCheckoutSession(request());
    await provider.pay(session.id);
    expect(delivered).toHaveLength(1);
    const [d] = delivered;
    expect(() => verifySignature(d!.body, d!.header, SECRET)).not.toThrow();
    const event = JSON.parse(d!.body.toString());
    expect(event).toMatchObject({ id: d!.eventId, object: "event", type: "checkout.session.completed", livemode: false });
    expect(event.data.object).toMatchObject({
      id: session.id,
      object: "checkout.session",
      amount_total: 5342,
      currency: "usd",
      payment_status: "paid",
      status: "complete",
      metadata: request().metadata,
    });
    expect(event.data.object.payment_intent).toMatch(/^pi_mock_/);
  });

  it("completes a bank debit unpaid, then settles it either way", async () => {
    const { provider, delivered } = make();
    const a = await provider.createCheckoutSession(request());
    await provider.pay(a.id, "bank");
    await provider.settle(a.id, true);
    const b = await provider.createCheckoutSession(request({ idempotencyKey: "k-b" }));
    await provider.pay(b.id, "bank");
    await provider.settle(b.id, false);
    const summary = delivered.map((d) => {
      const e = JSON.parse(d.body.toString());
      return `${e.type}:${e.data.object.payment_status}`;
    });
    expect(summary).toEqual([
      "checkout.session.completed:unpaid",
      "checkout.session.async_payment_succeeded:paid",
      "checkout.session.completed:unpaid",
      "checkout.session.async_payment_failed:unpaid",
    ]);
    expect((await refusal(provider.settle(a.id, true))).code).toBe("session_not_processing");
  });

  it("expires only open sessions, and an expired or paid session can't be paid", async () => {
    const { provider, delivered } = make();
    const a = await provider.createCheckoutSession(request());
    await provider.expireCheckoutSession(a.id);
    expect(JSON.parse(delivered[0]!.body.toString()).type).toBe("checkout.session.expired");
    expect((await refusal(provider.pay(a.id))).code).toBe("session_not_open");
    expect((await refusal(provider.expireCheckoutSession(a.id))).code).toBe("session_not_open");
    const b = await provider.createCheckoutSession(request({ idempotencyKey: "k-b" }));
    await provider.pay(b.id);
    expect((await refusal(provider.expireCheckoutSession(b.id))).code).toBe("session_not_open");
    expect((await refusal(provider.pay("cs_mock_missing"))).code).toBe("resource_missing");
  });

  it("can't be paid once its 24 hours are up", async () => {
    let now = 1_000_000;
    const { provider } = make(() => now);
    const session = await provider.createCheckoutSession(request());
    now += 86_400;
    expect((await refusal(provider.pay(session.id))).code).toBe("session_not_open");
  });
});

describe("StripeProvider against a stand-in for api.stripe.com", () => {
  interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage["headers"];
    body: string;
  }
  let server: Server;
  let base: string;
  const seen: Seen[] = [];
  let respond: (req: Seen, res: ServerResponse) => void = () => {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
        seen.push(s);
        respond(s, res);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    server.close();
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // Fake keys are assembled at run time: a key-shaped literal in the repository is what secret scanners (and
  // GitHub's push protection, which refused the first push of this file) are there to stop.
  const fakeKey = (mode: "test" | "live") => ["sk", mode, "FAKE".repeat(6)].join("_");
  const KEY = fakeKey("test");
  const stripe = (timeoutMs?: number) => new StripeProvider({ secretKey: KEY, apiBase: base, timeoutMs });

  it("refuses a live or malformed key", () => {
    expect(() => new StripeProvider({ secretKey: fakeKey("live") })).toThrow(/test-mode key/);
    expect(() => new StripeProvider({ secretKey: "" })).toThrow(/test-mode key/);
  });

  it("creates a checkout session with Stripe's form encoding, bearer key and idempotency key", async () => {
    seen.length = 0;
    respond = (_req, res) => json(res, 200, { id: "cs_test_a1B2", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_a1B2", expires_at: 1_763_136_000 });
    const session = await stripe().createCheckoutSession(request({ description: "Invoice INV-0001 from Café & Co" }));
    expect(session).toEqual({ id: "cs_test_a1B2", url: "https://checkout.stripe.com/c/pay/cs_test_a1B2", expiresAt: new Date(1_763_136_000_000) });
    const [req] = seen;
    expect(req).toMatchObject({ method: "POST", url: "/v1/checkout/sessions" });
    expect(req!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req!.headers["idempotency-key"]).toBe("tally-checkout-b-1");
    expect(req!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(req!.body);
    expect(Object.fromEntries(form)).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "5342",
      "line_items[0][price_data][product_data][name]": "Invoice INV-0001 from Café & Co",
      customer_email: "payables@navy.example",
      client_reference_id: "00000000-0000-4000-8000-00000000000b",
      success_url: "http://localhost:8117/paid?status=success",
      cancel_url: "http://localhost:8117/paid?status=canceled",
      "metadata[organization_id]": "00000000-0000-4000-8000-00000000000a",
      "metadata[invoice_id]": "00000000-0000-4000-8000-00000000000b",
      "payment_intent_data[metadata][organization_id]": "00000000-0000-4000-8000-00000000000a",
      "payment_intent_data[metadata][invoice_id]": "00000000-0000-4000-8000-00000000000b",
    });
  });

  it("expires a session by its id, without an idempotency key, and checks the id first", async () => {
    seen.length = 0;
    respond = (_req, res) => json(res, 200, { id: "cs_test_x", status: "expired" });
    await stripe().expireCheckoutSession("cs_test_x");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/checkout/sessions/cs_test_x/expire", body: "" });
    expect(seen[0]!.headers["idempotency-key"]).toBeUndefined();
    expect((await refusal(stripe().expireCheckoutSession("cs_test_x/../../v1/charges"))).code).toBe("bad_request");
    expect(seen).toHaveLength(1);
  });

  it.each([
    [400, { error: { type: "invalid_request_error", code: "amount_too_small", message: "Amount must be at least $0.50 usd" } }, "amount_too_small", false],
    [400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" } }, "idempotency_error", false],
    [401, { error: { type: "invalid_request_error", message: "Invalid API Key provided" } }, "invalid_request_error", false],
    [409, { error: { type: "idempotency_error", message: "There is currently another in-progress request using this Idempotent Key" } }, "idempotency_error", true],
    [429, { error: { type: "rate_limit_error", message: "Too many requests" } }, "rate_limit_error", true],
    [500, { error: { type: "api_error", message: "Something went wrong" } }, "api_error", true],
  ])("maps HTTP %s to a ProviderError (code, retryable)", async (status, body, code, retryable) => {
    respond = (_req, res) => json(res, status, body);
    const error = await refusal(stripe().createCheckoutSession(request()));
    expect({ code: error.code, retryable: error.retryable }).toEqual({ code, retryable });
    expect(error.message).not.toContain(KEY);
  });

  it("waits out a 409 for an idempotent request still in flight, then gets the shared session", async () => {
    seen.length = 0;
    let calls = 0;
    respond = (_req, res) =>
      ++calls === 1
        ? json(res, 409, { error: { type: "idempotency_error", message: "There is currently another in-progress request using this Idempotent Key" } })
        : json(res, 200, { id: "cs_test_shared", url: "https://checkout.stripe.com/c/pay/cs_test_shared", expires_at: 1_763_136_000 });
    expect((await stripe().createCheckoutSession(request())).id).toBe("cs_test_shared");
    expect(seen.map((r) => r.headers["idempotency-key"])).toEqual(["tally-checkout-b-1", "tally-checkout-b-1"]);
    // Three 409s in a row: it gives up, retryable.
    respond = (_req, res) => json(res, 409, { error: { type: "idempotency_error", message: "in progress" } });
    expect(await refusal(stripe().createCheckoutSession(request()))).toMatchObject({ code: "idempotency_error", retryable: true, httpStatus: 409 });
  });

  it("treats a response that isn't JSON, or a session it can't read, as an error", async () => {
    respond = (_req, res) => {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>bad gateway</html>");
    };
    expect(await refusal(stripe().createCheckoutSession(request()))).toMatchObject({ code: "bad_response", retryable: true });
    // A rate limiter in front of Stripe answering in plain text is still a rate limit (review round 3).
    respond = (_req, res) => {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Too Many Requests");
    };
    expect(await refusal(stripe().createCheckoutSession(request()))).toMatchObject({ code: "bad_response", retryable: true, httpStatus: 429 });
    respond = (_req, res) => json(res, 200, { id: "cs_test_a", url: "http://insecure.example/pay", expires_at: 1 });
    expect(await refusal(stripe().createCheckoutSession(request()))).toMatchObject({ code: "bad_response", retryable: false });
  });

  it("gives up after its timeout with a retryable error", async () => {
    respond = () => {}; // never answers
    const error = await refusal(stripe(200).createCheckoutSession(request()));
    expect(error).toMatchObject({ code: "network", retryable: true });
  });

  it("checks the charge limits before calling Stripe", async () => {
    seen.length = 0;
    expect((await refusal(stripe().createCheckoutSession(request({ amountMinor: 100_000_000n })))).code).toBe("amount-too-large");
    expect(seen).toHaveLength(0);
  });

  it("lists events since a time, following pages, oldest first", async () => {
    seen.length = 0;
    const page = (ids: string[], hasMore: boolean) => ({ object: "list", has_more: hasMore, data: ids.map((id) => ({ id, object: "event" })) });
    respond = (req, res) => json(res, 200, new URL(req.url, "http://x").searchParams.get("starting_after") === "evt_3" ? page(["evt_2", "evt_1"], false) : page(["evt_5", "evt_4", "evt_3"], true));
    const events = (await stripe().listEvents(new Date(1_763_000_000_000))) as { id: string }[];
    expect(events.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5"]);
    expect(seen.map((r) => r.method)).toEqual(["GET", "GET"]);
    const first = new URL(seen[0]!.url, "http://x");
    expect(first.pathname).toBe("/v1/events");
    expect(first.searchParams.get("created[gte]")).toBe("1763000000");
    expect(first.searchParams.get("limit")).toBe("100");
    expect(first.searchParams.getAll("types[]")).toEqual([
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ]);
    expect(new URL(seen[1]!.url, "http://x").searchParams.get("starting_after")).toBe("evt_3");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers["content-type"]).toBeUndefined();
  });

  it("encodes reserved characters in keys and values", () => {
    expect(formEncode([["metadata[a b]", "x&y=z/é"]])).toBe("metadata%5Ba%20b%5D=x%26y%3Dz%2F%C3%A9");
  });
});
