import { z } from "zod";
import { CHECKOUT_SESSION_ID } from "./provider";
import { SignatureError, verifySignature } from "./signature";

// From a webhook request's raw body and signature header to an event Tally acts on (DESIGN.md, "Billing").
// Only checkout-session events are handled; the session's metadata, which Tally wrote when it created the
// session and Stripe signed along with the rest of the event, names the organization and invoice.

export const HANDLED_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
] as const;
export type HandledType = (typeof HANDLED_TYPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Unknown fields are dropped (zod's default), so Stripe adding fields never breaks parsing.
const envelope = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/),
  object: z.literal("event"),
  type: z.string().regex(/^[a-z_.]{1,100}$/),
  created: z.number().int().positive().max(1e11),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

const checkoutSession = z.object({
  id: z.string().regex(CHECKOUT_SESSION_ID),
  object: z.literal("checkout.session"),
  amount_total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: z.string().regex(/^[a-z]{3}$/).nullable(),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  payment_intent: z.string().regex(/^pi_[A-Za-z0-9_]{1,250}$/).nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
});

export interface CheckoutEvent {
  id: string;
  type: HandledType;
  created: Date;
  organizationId: string;
  invoiceId: string;
  session: {
    id: string;
    amountTotal: bigint | null;
    /** Upper case, as Tally stores currencies (Stripe sends lower case). */
    currency: string | null;
    paymentStatus: "paid" | "unpaid" | "no_payment_required";
    paymentIntent: string | null;
  };
}

declare const verified: unique symbol;

/**
 * A CheckoutEvent whose signature was checked. Only parseWebhook makes one, and the data access layer's
 * runForStripeEvent takes only this type: an organization id reaches withTenant from a webhook only after the
 * signature over it verified.
 */
export type VerifiedCheckoutEvent = CheckoutEvent & { readonly [verified]: true };

export type ParsedWebhook =
  | { kind: "event"; event: VerifiedCheckoutEvent }
  /** Authentic, but nothing Tally acts on: answered 200 so Stripe stops sending it. */
  | { kind: "ignored"; reason: string; eventId: string }
  /** Not authentic or not an event: answered 400. */
  | { kind: "rejected"; reason: string };

export function parseWebhook(body: Uint8Array, header: string | null, secret: string, now?: number): ParsedWebhook {
  try {
    verifySignature(body, header, secret, { now });
  } catch (error) {
    if (error instanceof SignatureError) return { kind: "rejected", reason: error.message };
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return { kind: "rejected", reason: "body is not JSON" };
  }
  const event = envelope.safeParse(json);
  if (!event.success) return { kind: "rejected", reason: "body is not a Stripe event" };
  const { id, type, created, livemode, data } = event.data;
  // A test-mode endpoint secret only signs test-mode events, so this can't happen with the secrets Tally accepts;
  // checked anyway, since a live event would be real money.
  if (livemode) return { kind: "ignored", reason: "live-mode", eventId: id };
  if (!(HANDLED_TYPES as readonly string[]).includes(type)) return { kind: "ignored", reason: "unhandled-type", eventId: id };
  const session = checkoutSession.safeParse(data.object);
  // A handled type whose object Tally can't read is a bug here (or a Stripe API change): refuse it, so Stripe keeps
  // retrying (for up to three days) while it's fixed, rather than acknowledge it unprocessed.
  if (!session.success) return { kind: "rejected", reason: "unexpected checkout session shape" };
  const s = session.data;
  const organizationId = s.metadata?.organization_id;
  const invoiceId = s.metadata?.invoice_id;
  // Sessions Tally didn't create (another integration on the same Stripe account) carry no such metadata.
  if (!organizationId || !invoiceId || !UUID.test(organizationId) || !UUID.test(invoiceId)) {
    return { kind: "ignored", reason: "not-a-tally-session", eventId: id };
  }
  const parsed: CheckoutEvent = {
    id,
    type: type as HandledType,
    created: new Date(created * 1000),
    organizationId,
    invoiceId,
    session: {
      id: s.id,
      amountTotal: s.amount_total === null ? null : BigInt(s.amount_total),
      currency: s.currency === null ? null : s.currency.toUpperCase(),
      paymentStatus: s.payment_status,
      paymentIntent: s.payment_intent ?? null,
    },
  };
  return { kind: "event", event: parsed as VerifiedCheckoutEvent };
}
