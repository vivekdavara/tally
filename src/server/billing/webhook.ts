import type { TenantTx } from "@/server/db/tenant";
import { parseWebhook, type VerifiedCheckoutEvent } from "./events";
import { processCheckoutEvent } from "./service";

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
   * Runs after an event's transaction committed (the app: expire the invoice's other pending links once it is paid).
   * Its failure is logged; the answer stays 200, since the event itself was applied.
   */
  afterApplied?: (event: VerifiedCheckoutEvent, outcome: string) => Promise<void>;
}

export interface WebhookResponse {
  status: number;
  body: { result: string; reason?: string; outcome?: string };
}

export async function handleStripeWebhook(body: Uint8Array, header: string | null, deps: WebhookDeps): Promise<WebhookResponse> {
  const parsed = parseWebhook(body, header, deps.secret, deps.now);
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
  if (result.kind === "duplicate") return { status: 200, body: { result: "duplicate" } };
  if (result.kind === "processed") {
    try {
      await deps.afterApplied?.(event, result.outcome);
    } catch (error) {
      console.error(`billing: after ${event.id} (${result.outcome}): ${(error as Error).message}`);
    }
    return { status: 200, body: { result: "processed", outcome: result.outcome } };
  }
  // No such session in that organization. A deleted organization's events will never apply: acknowledge them.
  // Otherwise the session's row may not be committed yet (the window between creating a session and storing it),
  // so ask Stripe to retry.
  if (!(await deps.organizationExists(event.organizationId))) return { status: 200, body: { result: "ignored", reason: "organization-gone" } };
  return { status: 404, body: { result: "unknown-session" } };
}
