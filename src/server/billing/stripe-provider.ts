import { chargeability } from "./limits";
import { CHECKOUT_SESSION_ID, ProviderError, type BillingProvider, type CheckoutRequest, type CheckoutSession, type EventSource } from "./provider";

// Stripe's REST API, for test mode only, over fetch: two endpoints don't justify an SDK dependency, and a plain
// client is easy to test against a local server that checks every request (tests/unit/stripe-provider.test.ts).
// Opt-in: BILLING_PROVIDER=stripe with a test-mode secret key (src/server/billing/config.ts). Not exercised against
// Stripe itself by the tests or CI, which never have a key.

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]{10,250}$/;

export interface StripeProviderOptions {
  secretKey: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Stripe's form encoding: nested keys in brackets (metadata[invoice_id]=...). */
export function formEncode(fields: [string, string][]): string {
  return fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

export class StripeProvider implements BillingProvider, EventSource {
  readonly name = "stripe" as const;
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: StripeProviderOptions) {
    if (!TEST_KEY.test(options.secretKey)) {
      // A live key would move real money; this project only ever talks to Stripe's test mode.
      throw new Error("StripeProvider needs a test-mode key (sk_test_... or rk_test_...)");
    }
    this.apiBase = options.apiBase ?? "https://api.stripe.com";
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession> {
    const allowed = chargeability(request.amountMinor, request.currency);
    if (!allowed.ok) throw new ProviderError(`not chargeable: ${allowed.reason}`, allowed.reason, false);
    const { organization_id, invoice_id } = request.metadata;
    const body = formEncode([
      ["mode", "payment"],
      ["line_items[0][quantity]", "1"],
      ["line_items[0][price_data][currency]", request.currency.toLowerCase()],
      ["line_items[0][price_data][unit_amount]", request.amountMinor.toString()],
      ["line_items[0][price_data][product_data][name]", request.description],
      ["customer_email", request.customerEmail],
      ["client_reference_id", invoice_id],
      ["success_url", request.successUrl],
      ["cancel_url", request.cancelUrl],
      ["metadata[organization_id]", organization_id],
      ["metadata[invoice_id]", invoice_id],
      // On the PaymentIntent too, so refunds and disputes in Stripe's dashboard lead back to the invoice.
      ["payment_intent_data[metadata][organization_id]", organization_id],
      ["payment_intent_data[metadata][invoice_id]", invoice_id],
    ]);
    const json = await this.post("/v1/checkout/sessions", body, request.idempotencyKey);
    const id = json.id;
    const url = json.url;
    const expiresAt = json.expires_at;
    if (typeof id !== "string" || !CHECKOUT_SESSION_ID.test(id) || typeof url !== "string" || !url.startsWith("https://") || typeof expiresAt !== "number") {
      throw new ProviderError("Stripe returned a checkout session Tally can't read", "bad_response", false);
    }
    return { id, url, expiresAt: new Date(expiresAt * 1000) };
  }

  async expireCheckoutSession(id: string): Promise<void> {
    if (!CHECKOUT_SESSION_ID.test(id)) throw new ProviderError("not a checkout session id", "bad_request", false);
    await this.post(`/v1/checkout/sessions/${id}/expire`, "", undefined);
  }

  /**
   * Stripe answers 409 while another request with the same idempotency key is still in flight (two clicks at once).
   * Waiting briefly and asking again returns the first request's result, the shared session, instead of showing the
   * second click an error (review suspicion). Twice at most, 250 then 500 ms.
   */
  /**
   * GET /v1/events for the handled checkout-session types created at or after `since`: Stripe lists newest first, 100
   * a page, so this follows starting_after while has_more (at most 50 pages, 5,000 events) and returns them oldest
   * first. Stripe keeps events for 30 days.
   */
  async listEvents(since: Date): Promise<unknown[]> {
    const types = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"];
    const events: unknown[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const query = formEncode([
        ["limit", "100"],
        ["created[gte]", String(Math.floor(since.getTime() / 1000))],
        ...types.map((t): [string, string] => ["types[]", t]),
        ...(after ? [["starting_after", after] as [string, string]] : []),
      ]);
      const json = await this.request("GET", `/v1/events?${query}`, undefined, undefined);
      const data = Array.isArray(json.data) ? (json.data as { id?: unknown }[]) : [];
      events.push(...data);
      const last = data.at(-1)?.id;
      if (json.has_more !== true || typeof last !== "string") return events.reverse();
      after = last;
    }
    throw new ProviderError("more than 5,000 events to reconcile; use a later `since`", "too_many_events", false);
  }

  private async post(path: string, body: string, idempotencyKey: string | undefined): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request("POST", path, body, idempotencyKey);
      } catch (error) {
        const inFlight = error instanceof ProviderError && error.httpStatus === 409 && idempotencyKey !== undefined;
        if (!inFlight || attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }

  private async request(method: "GET" | "POST", path: string, body: string | undefined, idempotencyKey: string | undefined): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.options.secretKey}` };
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiBase}${path}`, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      // Timeouts and network failures: the request may or may not have reached Stripe, so only a retry with the
      // same idempotency key is safe, and that is what the caller's next attempt does.
      throw new ProviderError(`Stripe request failed: ${(error as Error).name}`, "network", true);
    }
    // 409: an idempotent request still in flight, or a lock timeout; 429: rate limited; 5xx: Stripe's side. Whatever
    // the body: a rate limiter or proxy in front of Stripe answers 429 in plain text, and that is still worth
    // retrying (review round 3: classed as permanent, it let the webhook acknowledge a link it hadn't expired).
    const retryable = response.status === 409 || response.status === 429 || response.status >= 500;
    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError(`Stripe answered ${response.status} without JSON`, "bad_response", retryable, response.status);
    }
    if (!response.ok) {
      const error = (json.error ?? {}) as { code?: unknown; type?: unknown; message?: unknown };
      const code = typeof error.code === "string" ? error.code : typeof error.type === "string" ? error.type : `http_${response.status}`;
      // Stripe's message only: it never contains the key, and the key is never logged here.
      throw new ProviderError(typeof error.message === "string" ? error.message : `Stripe answered ${response.status}`, code, retryable, response.status);
    }
    return json;
  }
}
