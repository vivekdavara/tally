import { randomBytes } from "node:crypto";
import { chargeability } from "./limits";
import { ProviderError, type BillingProvider, type CheckoutRequest, type CheckoutSession, type EventSource } from "./provider";
import { signatureHeader } from "./signature";

// The default provider: Stripe's checkout sessions, in memory. It answers like Stripe where Tally depends on it
// (idempotency keys, the charge limits, which sessions can be expired or paid), and plays the customer: paying,
// settling a bank debit or letting a session expire produces the event Stripe would send, as JSON signed with the
// webhook secret, handed to `deliver` (the app passes its own webhook handler, so the whole verification and
// processing path runs; tests capture deliveries to replay, duplicate or reorder them). State lives in this
// process only: a restart forgets every mock session, which is fine for a mock.

/** Stripe's default lifetime for a checkout session. */
const SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

export interface MockSession {
  id: string;
  url: string;
  request: CheckoutRequest;
  createdAt: number;
  expiresAt: number;
  status: "open" | "complete" | "expired";
  paymentStatus: "unpaid" | "paid";
  paymentIntent: string | null;
  /** Every event sent about this session and what the webhook answered (shown on the mock checkout page). */
  deliveries: { eventId: string; type: string; body: Buffer; answer: unknown }[];
}

/** An event as Stripe would POST it: the raw body and its Stripe-Signature header. */
export interface SignedDelivery {
  eventId: string;
  type: string;
  body: Buffer;
  header: string;
}

export interface MockProviderOptions {
  webhookSecret: string;
  deliver?: (delivery: SignedDelivery) => Promise<unknown>;
  /** Unix seconds; tests pass a clock. */
  now?: () => number;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export class MockProvider implements BillingProvider, EventSource {
  readonly name = "mock" as const;
  private readonly sessions = new Map<string, MockSession>();
  private readonly keys = new Map<string, { fingerprint: string; sessionId: string }>();
  /** Every event sent (not merely built), as Stripe keeps its event log: what listEvents returns. */
  private readonly sent: { created: number; body: Buffer }[] = [];

  constructor(private readonly options: MockProviderOptions) {}

  private now(): number {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }

  async createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession> {
    const allowed = chargeability(request.amountMinor, request.currency);
    if (!allowed.ok) throw new ProviderError(`Stripe would refuse this amount: ${allowed.reason}`, allowed.reason, false);
    const fingerprint = JSON.stringify({ ...request, amountMinor: request.amountMinor.toString(), idempotencyKey: undefined });
    const seen = this.keys.get(request.idempotencyKey);
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        throw new ProviderError("Keys for idempotent requests can only be used with the same parameters", "idempotency_error", false);
      }
      return this.view(this.sessions.get(seen.sessionId)!);
    }
    const id = `cs_mock_${hex(16)}`;
    const createdAt = this.now();
    const session: MockSession = {
      id,
      url: `/mock-checkout/${id}`,
      request,
      createdAt,
      expiresAt: createdAt + SESSION_LIFETIME_SECONDS,
      status: "open",
      paymentStatus: "unpaid",
      paymentIntent: null,
      deliveries: [],
    };
    this.sessions.set(id, session);
    this.keys.set(request.idempotencyKey, { fingerprint, sessionId: id });
    return this.view(session);
  }

  async expireCheckoutSession(id: string): Promise<void> {
    const session = await this.open(id);
    session.status = "expired";
    await this.emit("checkout.session.expired", session);
  }

  /** The session behind a mock checkout page, or undefined. */
  session(id: string): MockSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * The customer pays. By card the money is there at once (checkout.session.completed, paid); by bank debit the
   * session completes unpaid and the money arrives, or doesn't, later (settle()).
   */
  async pay(id: string, method: "card" | "bank" = "card"): Promise<SignedDelivery> {
    const session = await this.open(id);
    session.status = "complete";
    session.paymentIntent = `pi_mock_${hex(12)}`;
    session.paymentStatus = method === "card" ? "paid" : "unpaid";
    return this.emit("checkout.session.completed", session);
  }

  /** A bank debit from pay(id, "bank") settles or fails. */
  async settle(id: string, succeeded: boolean): Promise<SignedDelivery> {
    const session = this.sessions.get(id);
    if (!session || session.status !== "complete" || session.paymentStatus !== "unpaid") {
      throw new ProviderError("only a completed, unpaid session can settle", "session_not_processing", false);
    }
    if (succeeded) session.paymentStatus = "paid";
    return this.emit(succeeded ? "checkout.session.async_payment_succeeded" : "checkout.session.async_payment_failed", session);
  }

  /** Lets an open session run out, as Stripe does at expires_at. */
  async lapse(id: string): Promise<SignedDelivery> {
    const session = await this.open(id);
    session.status = "expired";
    return this.emit("checkout.session.expired", session);
  }

  /**
   * Sends the session's last event again, re-signed with a fresh timestamp but the same id and body, as Stripe's
   * retries do: the webhook must answer "duplicate" and change nothing.
   */
  async redeliver(id: string): Promise<SignedDelivery> {
    const session = this.sessions.get(id);
    const last = session?.deliveries.at(-1);
    if (!session || !last) throw new ProviderError("nothing to redeliver", "resource_missing", false);
    const delivery = { eventId: last.eventId, type: last.type, body: last.body, header: signatureHeader(this.options.webhookSecret, this.now(), last.body) };
    const answer = await this.options.deliver?.(delivery);
    session.deliveries.push({ eventId: last.eventId, type: last.type, body: last.body, answer });
    return delivery;
  }

  /** The event Stripe would send about `session` now, signed. Doesn't deliver it. */
  event(type: string, session: MockSession, created = this.now()): SignedDelivery {
    const eventId = `evt_mock_${hex(12)}`;
    const body = Buffer.from(
      JSON.stringify({
        id: eventId,
        object: "event",
        api_version: "mock",
        created,
        livemode: false,
        pending_webhooks: 1,
        type,
        data: {
          object: {
            id: session.id,
            object: "checkout.session",
            amount_total: Number(session.request.amountMinor),
            currency: session.request.currency.toLowerCase(),
            client_reference_id: session.request.metadata.invoice_id,
            customer_email: session.request.customerEmail,
            expires_at: session.expiresAt,
            metadata: session.request.metadata,
            mode: "payment",
            payment_intent: session.paymentIntent,
            payment_status: session.paymentStatus,
            status: session.status,
            url: session.status === "open" ? session.url : null,
          },
        },
      }),
    );
    return { eventId, type, body, header: signatureHeader(this.options.webhookSecret, this.now(), body) };
  }

  private async open(id: string): Promise<MockSession> {
    const session = this.sessions.get(id);
    if (!session) throw new ProviderError("No such checkout session", "resource_missing", false);
    if (session.status !== "open") throw new ProviderError(`the session is ${session.status}, not open`, "session_not_open", false);
    if (this.now() >= session.expiresAt) {
      // It ran out: Stripe sends checkout.session.expired for that too (review round 5: the mock sent nothing).
      session.status = "expired";
      await this.emit("checkout.session.expired", session);
      throw new ProviderError("the session has expired", "session_not_open", false);
    }
    return session;
  }

  async listEvents(since: Date): Promise<unknown[]> {
    const from = Math.floor(since.getTime() / 1000);
    return this.sent.filter((e) => e.created >= from).map((e) => JSON.parse(e.body.toString("utf8")) as unknown);
  }

  private async emit(type: string, session: MockSession): Promise<SignedDelivery> {
    const delivery = this.event(type, session);
    // Logged before delivery, as Stripe records an event whether or not its webhook gets through.
    this.sent.push({ created: (JSON.parse(delivery.body.toString("utf8")) as { created: number }).created, body: delivery.body });
    const answer = await this.options.deliver?.(delivery);
    session.deliveries.push({ eventId: delivery.eventId, type, body: delivery.body, answer });
    return delivery;
  }

  private view(session: MockSession): CheckoutSession {
    return { id: session.id, url: session.url, expiresAt: new Date(session.expiresAt * 1000) };
  }
}
