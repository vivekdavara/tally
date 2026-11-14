import type { TenantTx } from "../db/tenant";
import type { Mailer } from "../mail/mailer";
import { claimReminders, markFailed, markSent, queueDueReminders, reminderMessage } from "./service";

// The overdue-reminders job (DESIGN.md, "Overdue reminders"): for each organization in turn, in its own transactions
// (so one tenant's failure doesn't stop the others, and row-level security limits each step to that tenant), queue
// what is due, then claim, send and record in batches. Safe to run on several workers at once.

export type OrganizationRun = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

export interface ReminderJobDeps {
  /** Calls `fn` for every organization, with a run bound to it (src/server/dal.ts, forEachOrganization). */
  forEachOrganization(fn: (organizationId: string, run: OrganizationRun) => Promise<void>): Promise<void>;
  mailer: Mailer;
  appBaseUrl: string;
  batchSize?: number;
  /** Stops between batches (the worker's shutdown signal). */
  signal?: AbortSignal;
}

export interface ReminderReport {
  organizations: number;
  queued: number;
  sent: number;
  failed: number;
  /** Organizations whose step threw (a database error): retried on the next run. */
  errors: { organizationId: string; step: "queue" | "claim" | "record"; message: string }[];
}

export async function runReminderJob(deps: ReminderJobDeps): Promise<ReminderReport> {
  const report: ReminderReport = { organizations: 0, queued: 0, sent: 0, failed: 0, errors: [] };
  const batchSize = deps.batchSize ?? 50;
  await deps.forEachOrganization(async (organizationId, run) => {
    if (deps.signal?.aborted) return;
    report.organizations++;
    const fail = (step: ReminderReport["errors"][number]["step"], error: unknown) =>
      report.errors.push({ organizationId, step, message: (error as Error).message?.slice(0, 300) ?? String(error) });
    try {
      report.queued += await run((tx) => queueDueReminders(tx));
    } catch (error) {
      // A race with paying an invoice (the trigger refuses its reminder) aborts this organization's queueing; what
      // was due is queued on the next run. Sending what is already queued goes on.
      fail("queue", error);
    }
    for (;;) {
      if (deps.signal?.aborted) return;
      let claimed;
      try {
        claimed = await run((tx) => claimReminders(tx, batchSize));
      } catch (error) {
        fail("claim", error);
        return;
      }
      if (claimed.length === 0) return;
      for (const reminder of claimed) {
        let sendError: unknown = null;
        try {
          await deps.mailer.send(reminderMessage(reminder, deps.appBaseUrl));
        } catch (error) {
          sendError = error;
        }
        try {
          if (sendError) {
            await run((tx) => markFailed(tx, reminder.id, reminder.attempts, (sendError as Error).message ?? String(sendError)));
            report.failed++;
          } else {
            await run((tx) => markSent(tx, reminder.id));
            report.sent++;
          }
        } catch (error) {
          // Sent (or failed) but not recorded: the claim lapses after the lease and the reminder is retried; the
          // mailer's idempotency key makes a provider that honours it drop the repeat.
          fail("record", error);
        }
      }
      if (claimed.length < batchSize) return;
    }
  });
  return report;
}
