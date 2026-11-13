import type { TenantTx } from "@/server/db/tenant";
import { parseWebhook, type ParsedWebhook, type VerifiedCheckoutEvent } from "./events";
import { processCheckoutEvent, type StaleLink } from "./service";

// The webhook endpoint's logic (POST /api/stripe/webhook), without Next.js, so tests call it directly. What each
// answer means to Stripe: any 2xx stops its retries; anything else is retried with backoff for up to three days.

export interface WebhookDeps {
  secret: string;
  /** Runs fn in the event's organization's transaction: the data access layer's runForStripeEvent. */
  run: <T>(event: VerifiedCheckoutEvent, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  organizationExists: (id: string) => Promise<boolean>;
  /** Unix seconds, for tests. */
  now?: number;
  /**
   * After-effects of an applied event, run after its transaction committed (the app: expire the invoice's other
   * pending links once it is paid). Run again on every redelivery of that event, with the stored outcome, so they
   * must be idempotent; if they throw, the answer is 500 and Stripe redelivers (review round 2: run only on the first
   * delivery and with failures swallowed, a crash or a transient provider error left a second link payable).
   */
  afterApplied?: (event: VerifiedCheckoutEvent, outcome: string, staleLinks: StaleLink[]) => Promise<void>;
}

export interface WebhookResponse {
  status: number;
  /** `applied`: set on a 500 whose event was applied (processed or a duplicate) but whose after-effects failed. */
  body: { result: string; reason?: string; outcome?: string; applied?: "processed" | "duplicate" };
}

export async function handleStripeWebhook(body: Uint8Array, header: string | null, deps: WebhookDeps): Promise<WebhookResponse> {
  return applyParsed(parseWebhook(body, header, deps.secret, deps.now), deps);
}

/** What the handler does with a parsed event; reconciliation (reconcile.ts) feeds fetched events through it too. */
export async function applyParsed(parsed: ParsedWebhook, deps: Omit<WebhookDeps, "secret" | "now">): Promise<WebhookResponse> {
  if (parsed.kind === "rejected") return { status: 400, body: { result: "rejected", reason: parsed.reason } };
  if (parsed.kind === "ignored") return { status: 200, body: { result: "ignored", reason: parsed.reason } };
  const { event } = parsed;
  let result;
  try {
    result = await deps.run(event, (tx) => processCheckoutEvent(tx, event));
  } catch (error) {
    // Rolled back, nothing stored: Stripe's retry will apply it.
    console.error(`billing: processing ${event.id} (${event.type}) failed: ${(error as Error).message}`);
    return { status: 500, body: { result: "error" } };
  }
  if (result.kind === "processed" || result.kind === "duplicate") {
    const outcome = result.outcome;
    if (outcome !== null && deps.afterApplied) {
      try {
        await deps.afterApplied(event, outcome, result.staleLinks);
      } catch (error) {
        // The event stays applied; Stripe's retry will be a duplicate that runs the after-effects again.
        console.error(`billing: after-effects of ${event.id} (${outcome}) failed: ${(error as Error).message}`);
        return { status: 500, body: { result: "error", reason: "after-effects failed", applied: result.kind } };
      }
    }
    return result.kind === "duplicate"
      ? { status: 200, body: { result: "duplicate" } }
      : { status: 200, body: { result: "processed", outcome: result.outcome } };
  }
  // No such session in that organization. A deleted organization's events will never apply: acknowledge them.
  // Otherwise the session's row may not be committed yet (the window between creating a session and storing it),
  // so ask Stripe to retry.
  if (!(await deps.organizationExists(event.organizationId))) return { status: 200, body: { result: "ignored", reason: "organization-gone" } };
  return { status: 404, body: { result: "unknown-session" } };
}
