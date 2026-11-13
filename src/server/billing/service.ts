import { createHash } from "node:crypto";
import { sqlState, violatedUniqueConstraint } from "@/server/db/errors";
import type { TenantTx } from "@/server/db/tenant";
import { invoiceLabel } from "@/server/invoices/format";
import { isCurrency, type Currency } from "@/server/invoices/money";
import type { Result } from "@/server/invoices/service";
import type { CheckoutEvent } from "./events";
import { chargeability } from "./limits";
import { ProviderError, type BillingProvider, type CheckoutRequest } from "./provider";

// Collecting open invoices through the provider, and applying its events (DESIGN.md, "Billing").

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (reason: string): Result<never> => ({ ok: false, reason });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** requireTenant(...).run, or withTenant bound to one organization in tests. */
export type TenantRun = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** A PENDING session isn't marked expired by Tally's own clock until this long after Stripe's expires_at. */
export const LOCAL_EXPIRY_GRACE = "5 minutes";

export interface PaymentView {
  id: string;
  status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "EXPIRED";
  provider: string;
  checkoutUrl: string;
  amountMinor: bigint;
  currency: string;
  expiresAt: Date;
  paidAt: Date | null;
  refundDue: boolean;
  createdAt: Date;
}

export async function listPayments(tx: TenantTx, invoiceId: string): Promise<PaymentView[]> {
  if (!UUID.test(invoiceId)) return [];
  return tx.payment.findMany({
    where: { invoiceId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: { id: true, status: true, provider: true, checkoutUrl: true, amountMinor: true, currency: true, expiresAt: true, paidAt: true, refundDue: true, createdAt: true },
  });
}

export interface CheckoutDeps {
  provider: BillingProvider;
  appBaseUrl: string;
  organizationName: string;
}

/**
 * The idempotency key for a checkout request: the invoice, the attempt number, and a digest of everything else the
 * request says. Two clicks at once, or a retry after a crash, send the same request and get the same session. A
 * request that differs (the organization renamed, APP_BASE_URL changed) gets a new key: under the old key Stripe
 * would refuse it as a reused key with other parameters, a non-retryable error, and since nothing was stored the
 * attempt number wouldn't move, so the invoice couldn't be collected for 24 hours (review suspicion). The session
 * the crashed attempt created was never shown to anyone and expires on its own.
 */
export function checkoutIdempotencyKey(invoiceId: string, attempt: number, request: Omit<CheckoutRequest, "idempotencyKey">): string {
  const digest = createHash("sha256").update(JSON.stringify({ ...request, amountMinor: request.amountMinor.toString() })).digest("hex");
  return `tally-checkout-${invoiceId}-${attempt}-${digest.slice(0, 16)}`;
}

interface Plan {
  reuse?: { url: string };
  attempt?: number;
  organizationId?: string;
  invoice?: { number: number; currency: Currency; total: bigint; email: string };
}

/**
 * A payment link for an open invoice: the live session if there is one, else a new checkout session for the
 * invoice's stored total. The provider call happens between two transactions, never inside one (a slow provider
 * would hold the invoice's locks and the connection). Its idempotency key is the invoice and the attempt number,
 * so two clicks at once, or a retry after a crash between the call and the insert, get the same session; the
 * insert then keeps one row (ON CONFLICT on the session id).
 */
export async function startCheckout(run: TenantRun, givenId: string, deps: CheckoutDeps): Promise<Result<{ url: string; reused: boolean }>> {
  if (!UUID.test(givenId)) return fail("not-found");
  // Postgres reads a UUID in either case, but the id also goes into the session's metadata and the idempotency key,
  // and events are matched on it: an upper-case id from the URL made every event for the session "not ours", so a
  // paid checkout was never recorded (review of day 3). Lower case, as Postgres prints it, from here on.
  const invoiceId = givenId.toLowerCase();
  const plan: Plan | Result<never> = await run(async (tx) => {
    // The invoice's row lock first: every payment insert and status change for this invoice takes it too, so the
    // reads below (live attempt, attempt count) see one state. Without it, under READ COMMITTED each statement has
    // its own snapshot: a click could miss a payment committed between them in the first and count it in the
    // second, and ask the provider for attempt 2, a second session (found by the 8-click test on day 3).
    const rows = await tx.$queryRaw<{ status: string; number: number | null; currency: string; totalMinor: bigint | null; billToEmail: string | null }[]>`
      SELECT status::text AS status, number, currency, total_minor AS "totalMinor", bill_to_email AS "billToEmail"
      FROM invoices WHERE id = ${invoiceId}::uuid FOR NO KEY UPDATE`;
    const invoice = rows[0];
    if (!invoice) return fail("not-found");
    if (invoice.status !== "OPEN") return fail("not-open");
    if (!isCurrency(invoice.currency)) return fail("currency-not-chargeable");
    const allowed = chargeability(invoice.totalMinor!, invoice.currency);
    if (!allowed.ok) return fail(allowed.reason);
    // A pending session well past Stripe's expiry can no longer be paid: end it here, so a new one can be made.
    await tx.$executeRaw`
      UPDATE payments SET status = 'EXPIRED'
      WHERE invoice_id = ${invoiceId}::uuid AND status = 'PENDING'
        AND expires_at <= clock_timestamp() - ${LOCAL_EXPIRY_GRACE}::interval`;
    const live = await tx.$queryRaw<{ url: string; usable: boolean }[]>`
      SELECT checkout_url AS url, (status = 'PROCESSING' OR expires_at > clock_timestamp()) AS usable
      FROM payments WHERE invoice_id = ${invoiceId}::uuid AND status IN ('PENDING', 'PROCESSING')`;
    if (live[0]) return live[0].usable ? { reuse: { url: live[0].url } } : fail("checkout-expiring");
    const attempt = (await tx.payment.count({ where: { invoiceId } })) + 1;
    const tenant = await tx.$queryRaw<{ id: string }[]>`SELECT current_setting('app.organization_id', true) AS id`;
    return {
      attempt,
      organizationId: tenant[0]!.id,
      invoice: { number: invoice.number!, currency: invoice.currency, total: invoice.totalMinor!, email: invoice.billToEmail! },
    };
  });
  if ("ok" in plan) return plan;
  if (plan.reuse) return ok({ url: plan.reuse.url, reused: true });
  const { attempt, organizationId, invoice } = plan as Required<Plan>;

  const request = {
    amountMinor: invoice.total,
    currency: invoice.currency,
    // Cut by code points: slice() counts UTF-16 units and could split an emoji's surrogate pair, which
    // encodeURIComponent then refuses (URIError) when the Stripe client form-encodes it (review suspicion).
    description: Array.from(`Invoice ${invoiceLabel(invoice.number)} from ${deps.organizationName}`).slice(0, 250).join(""),
    customerEmail: invoice.email,
    successUrl: `${deps.appBaseUrl}/paid?status=success`,
    cancelUrl: `${deps.appBaseUrl}/paid?status=canceled`,
    metadata: { organization_id: organizationId, invoice_id: invoiceId },
  };
  let session;
  try {
    session = await deps.provider.createCheckoutSession({ ...request, idempotencyKey: checkoutIdempotencyKey(invoiceId, attempt, request) });
  } catch (error) {
    if (error instanceof ProviderError) {
      if (["amount-too-small", "amount-too-large", "currency-not-chargeable"].includes(error.code)) return fail(error.code);
      console.error(`billing: creating a checkout session failed (${error.code}${error.retryable ? ", retryable" : ""}): ${error.message}`);
      return fail(error.retryable ? "provider-unavailable" : "provider-error");
    }
    throw error;
  }

  try {
    const url = await run(async (tx) => {
      // Timestamps go to raw SQL as ISO strings with their zone, not as Dates: Prisma's adapter sends a Date without
      // one (src/server/db/client.ts pins sessions to UTC for that reason; this doesn't depend on it).
      // Payment creation takes turns per invoice. Without this, two clicks storing the same session at once could
      // both pass ON CONFLICT's check and the second then hit payments_one_live_per_invoice, a unique index that
      // isn't the conflict target, so it errors instead of doing nothing (seen on day 3 once round 1 made that
      // error visible). The invoice comes first, as in every other path.
      await tx.$queryRaw`SELECT 1 FROM invoices WHERE id = ${invoiceId}::uuid FOR NO KEY UPDATE`;
      const inserted = await tx.$queryRaw<{ url: string }[]>`
        INSERT INTO payments (organization_id, invoice_id, provider, checkout_session_id, checkout_url, amount_minor, currency, expires_at)
        VALUES (NULLIF(current_setting('app.organization_id', true), '')::uuid, ${invoiceId}::uuid, ${deps.provider.name}, ${session.id},
                ${session.url}, ${invoice.total}, ${invoice.currency}, ${session.expiresAt.toISOString()}::timestamptz)
        ON CONFLICT (organization_id, checkout_session_id) DO NOTHING
        RETURNING checkout_url AS url`;
      if (inserted[0]) return inserted[0].url;
      // The same session, inserted by a concurrent click: one row, the same link.
      const existing = await tx.payment.findFirstOrThrow({ where: { checkoutSessionId: session.id }, select: { checkoutUrl: true } });
      return existing.checkoutUrl;
    });
    return ok({ url, reused: false });
  } catch (error) {
    const state = sqlState(error);
    if (state === "TL012" || state === "TL013") {
      // Paid, voided or (impossibly) changed between the two transactions: nobody should pay this session.
      await deps.provider.expireCheckoutSession(session.id).catch((e: unknown) => console.error(`billing: expiring ${session.id} failed: ${(e as Error).message}`));
      return fail("not-open");
    }
    if (violatedUniqueConstraint(error) === "payments_one_live_per_invoice") {
      // Another session for this invoice was stored first. If it is this very session, that's just the other click's
      // insert: share it. Otherwise this one was never shown to anyone, so end it.
      const live = await run((tx) =>
        tx.payment.findFirst({ where: { invoiceId, status: { in: ["PENDING", "PROCESSING"] } }, select: { checkoutSessionId: true, checkoutUrl: true } }),
      );
      if (live?.checkoutSessionId === session.id) return ok({ url: live.checkoutUrl, reused: false });
      await deps.provider.expireCheckoutSession(session.id).catch((e: unknown) => console.error(`billing: expiring ${session.id} failed: ${(e as Error).message}`));
      return fail("checkout-busy");
    }
    throw error;
  }
}

/**
 * Ends an invoice's pending sessions at the provider, so the customer can't pay them (after it was paid by hand,
 * voided, or paid by another attempt). The provider then sends checkout.session.expired, which marks each payment
 * EXPIRED. PROCESSING payments can't be expired (the customer already submitted a bank debit). Returns how many were
 * expired and the failures worth retrying (network, 429, 5xx); a refusal that won't change on retry (the session is
 * already expired or paid) is only logged. A session that is paid anyway is still recorded, with refund_due set.
 */
export async function expirePendingCheckouts(
  run: TenantRun,
  invoiceId: string,
  provider: BillingProvider,
): Promise<{ expired: number; retryable: string[] }> {
  if (!UUID.test(invoiceId)) return { expired: 0, retryable: [] };
  const pending = await run((tx) => tx.payment.findMany({ where: { invoiceId, status: "PENDING", provider: provider.name }, select: { checkoutSessionId: true } }));
  let expired = 0;
  const retryable: string[] = [];
  for (const { checkoutSessionId } of pending) {
    try {
      await provider.expireCheckoutSession(checkoutSessionId);
      expired += 1;
    } catch (error) {
      console.error(`billing: expiring ${checkoutSessionId} failed: ${(error as Error).message}`);
      if (error instanceof ProviderError && error.retryable) retryable.push(checkoutSessionId);
    }
  }
  return { expired, retryable };
}

/**
 * WebhookDeps.afterApplied for the app: once an event has paid an invoice, end its other pending payment links. A
 * late success on an attempt given up on (FAILED, EXPIRED) can pay the invoice while a newer link is still live, and
 * the customer could pay that one too (review round 1's suspicion). It must not be best effort (review round 2): it
 * throws when an expiry failed in a way a retry could fix, so the webhook answers 500 and Stripe redelivers; the
 * redelivery is a duplicate, which runs this again with the stored outcome. The same happens if the process died
 * after the event's commit and before this finished.
 */
export function expireOthersWhenPaid<E extends CheckoutEvent>(provider: BillingProvider, runFor: (event: E) => TenantRun) {
  return async (event: E, outcome: string): Promise<void> => {
    if (outcome !== "invoice-paid") return;
    const { retryable } = await expirePendingCheckouts(runFor(event), event.invoiceId, provider);
    if (retryable.length > 0) throw new Error(`couldn't expire ${retryable.join(", ")} yet`);
  };
}

// Webhook events -------------------------------------------------------------------------------------------------

export type EventResult =
  | { kind: "processed"; outcome: string }
  /** Applied before; `outcome` is what that application recorded, so its after-effects can run again. */
  | { kind: "duplicate"; outcome: string | null }
  /** No payment has this session in the event's organization: nothing was stored, so a retry can still apply it. */
  | { kind: "unknown-session" };

type Status = PaymentView["status"];

/**
 * Applies one verified event in its organization's transaction, exactly once:
 * 1. find the payment by session id (row security limits this to the organization the event names);
 * 2. insert the event id into stripe_events, ON CONFLICT DO NOTHING: a second delivery of the same event finds it
 *    (or, while the first is still in flight, waits on its uncommitted key, then finds it) and changes nothing;
 * 3. lock the invoice, then the payment (the same order as every other path, so no deadlock), and move them;
 * 4. record what happened as the event's outcome.
 * Payment statuses only move forward (payments_guard), so events arriving out of order can't undo each other: a
 * success after a failure still records the money; a failure or expiry after a success is "stale".
 */
export async function processCheckoutEvent(tx: TenantTx, event: CheckoutEvent): Promise<EventResult> {
  const found = await tx.payment.findFirst({ where: { checkoutSessionId: event.session.id }, select: { id: true, invoiceId: true } });
  if (!found) return { kind: "unknown-session" };
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO stripe_events (id, organization_id, type, payment_id, stripe_created_at)
    VALUES (${event.id}, NULLIF(current_setting('app.organization_id', true), '')::uuid, ${event.type}, ${found.id}::uuid,
            ${event.created.toISOString()}::timestamptz)
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  if (inserted.length === 0) {
    const stored = await tx.stripeEvent.findUnique({ where: { id: event.id }, select: { outcome: true } });
    return { kind: "duplicate", outcome: stored?.outcome ?? null };
  }

  const outcome = await apply(tx, event, found);
  await tx.stripeEvent.update({ where: { id: event.id }, data: { outcome } });
  return { kind: "processed", outcome };
}

async function apply(tx: TenantTx, event: CheckoutEvent, found: { id: string; invoiceId: string }): Promise<string> {
  // The metadata is ours and signed, so this only fails on a bug: refuse to touch either row.
  if (event.invoiceId !== found.invoiceId) return "invoice-mismatch";
  const invoices = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM invoices WHERE id = ${found.invoiceId}::uuid FOR NO KEY UPDATE`;
  // FOR NO KEY UPDATE, not FOR UPDATE: the stripe_events insert's foreign-key check holds FOR KEY SHARE on this
  // row, which FOR UPDATE conflicts with. Two different events for one payment then deadlocked (each held its key
  // share and waited for the other's invoice lock; found by the concurrent-events test).
  const payments = await tx.$queryRaw<{ status: Status; amount_minor: bigint; currency: string }[]>`
    SELECT status, amount_minor, currency FROM payments WHERE id = ${found.id}::uuid FOR NO KEY UPDATE`;
  const invoice = invoices[0]!;
  const payment = payments[0]!;
  const setStatus = (status: Status) => tx.payment.update({ where: { id: found.id }, data: { status } });

  const succeeded =
    event.type === "checkout.session.async_payment_succeeded" ||
    (event.type === "checkout.session.completed" && event.session.paymentStatus === "paid");

  if (succeeded) {
    if (payment.status === "SUCCEEDED") return "already-succeeded";
    const matches = event.session.amountTotal === payment.amount_minor && event.session.currency === payment.currency;
    // Money arrived for an invoice that no longer wants it, or for the wrong amount: record it and flag a refund,
    // never pay the invoice with it.
    const refundDue = !matches || invoice.status !== "OPEN";
    await tx.payment.update({
      where: { id: found.id },
      data: { status: "SUCCEEDED", paidAt: event.created, paymentIntentId: event.session.paymentIntent, refundDue },
    });
    if (!matches) return "amount-mismatch";
    if (invoice.status === "OPEN") {
      await tx.invoice.update({ where: { id: found.invoiceId }, data: { status: "PAID" } });
      return "invoice-paid";
    }
    return invoice.status === "VOID" ? "refund-due-void" : "refund-due-paid";
  }

  if (event.type === "checkout.session.completed") {
    // Completed but unpaid: a bank debit submitted, settling later. (no_payment_required can't happen: every
    // session is for at least Stripe's minimum.)
    if (event.session.paymentStatus !== "unpaid" || payment.status !== "PENDING") return "stale";
    await setStatus("PROCESSING");
    return "payment-processing";
  }
  if (event.type === "checkout.session.async_payment_failed") {
    if (payment.status !== "PENDING" && payment.status !== "PROCESSING") return "stale";
    await setStatus("FAILED");
    return "payment-failed";
  }
  // checkout.session.expired
  if (payment.status !== "PENDING") return "stale";
  await setStatus("EXPIRED");
  return "payment-expired";
}
