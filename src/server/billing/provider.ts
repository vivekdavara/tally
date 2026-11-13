import type { Currency } from "@/server/invoices/money";

// The payment provider behind an interface (DESIGN.md, "Billing"). Tally needs two calls: create a hosted
// checkout session for an amount, and expire one nobody should pay any more. Everything else arrives as signed
// webhook events. Two implementations: MockProvider (the default; in memory, no network, drives the webhook
// path with signed events) and StripeProvider (Stripe's REST API in test mode, opt-in with a test key).

export interface CheckoutRequest {
  amountMinor: bigint;
  currency: Currency;
  /** The line the customer sees on the payment page ("Invoice INV-0042 from Acme"). */
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * Copied onto the session, so every event about it carries them: how a webhook finds its tenant. Signed by
   * Stripe along with the rest of the event, so they can't be forged.
   */
  metadata: { organization_id: string; invoice_id: string };
  /**
   * The same key with the same parameters returns the same session instead of a second one (Stripe keeps keys
   * for at least 24 hours); the same key with different parameters is an error.
   */
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  /** The hosted payment page. */
  url: string;
  expiresAt: Date;
}

export interface BillingProvider {
  readonly name: "mock" | "stripe";
  createCheckoutSession(request: CheckoutRequest): Promise<CheckoutSession>;
  /** Ends an open session so it can't be paid; Stripe then sends checkout.session.expired. */
  expireCheckoutSession(id: string): Promise<void>;
}

/** The provider's event log, for reconciliation (both providers implement it). */
export interface EventSource {
  /**
   * The checkout-session events the provider created at or after `since`, oldest first, as the raw event objects a
   * webhook would carry: reconciliation replays them for deliveries that never arrived.
   */
  listEvents(since: Date): Promise<unknown[]>;
}

/** A refusal or failure from the provider. `retryable`: the same call may succeed later (network, 429, 5xx). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    /** The HTTP status, when the provider answered one. */
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,250}$/;
