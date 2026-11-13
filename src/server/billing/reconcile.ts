import { parseFetchedEvent } from "./events";
import type { EventSource } from "./provider";
import { applyParsed, type WebhookDeps } from "./webhook";

// Reconciliation (DESIGN.md, "Billing"): webhooks are the fast path, the provider's event log is the record. If the
// endpoint was down longer than Stripe's retries (three days in live mode, a few hours in test mode), deliveries are
// lost; this lists the provider's checkout-session events since a point in time and applies each through the same
// path a delivery takes. The inbox makes that safe to run any number of times: an event already applied answers
// "duplicate" and changes nothing, its after-effects run again.

export interface ReconcileReport {
  fetched: number;
  processed: number;
  duplicate: number;
  ignored: number;
  /** Not applied (unknown session, refused, failed); the next run tries them again. */
  notApplied: { eventId: string | null; status: number; result: string }[];
}

export async function reconcileEvents(source: EventSource, since: Date, deps: Omit<WebhookDeps, "secret" | "now">): Promise<ReconcileReport> {
  const events = await source.listEvents(since);
  const report: ReconcileReport = { fetched: events.length, processed: 0, duplicate: 0, ignored: 0, notApplied: [] };
  // Oldest first, as they happened; statuses only move forward, so the order matters for the outcomes recorded, not
  // for where payments end up.
  for (const raw of events) {
    const answer = await applyParsed(parseFetchedEvent(raw), deps);
    const result = answer.body.result;
    if (answer.status === 200 && result === "processed") report.processed += 1;
    else if (answer.status === 200 && result === "duplicate") report.duplicate += 1;
    else if (answer.status === 200 && result === "ignored") report.ignored += 1;
    else {
      const id = (raw as { id?: unknown } | null)?.id;
      report.notApplied.push({ eventId: typeof id === "string" ? id : null, status: answer.status, result });
    }
  }
  return report;
}
