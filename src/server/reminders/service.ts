import type { TenantTx } from "../db/tenant";
import { formatDate, invoiceLabel } from "../invoices/format";
import { formatMoney, isCurrency } from "../invoices/money";
import type { MailMessage } from "../mail/mailer";

// Overdue reminders (DESIGN.md, "Overdue reminders"): queued per organization in its own transaction, then sent
// between two transactions (claim, send, record), like the payment provider calls: an email is never sent while
// holding a transaction open, and a crash between sending and recording leaves a claim that lapses and is retried
// (at least once; the mailer gets the reminder's id as its idempotency key).

/** Days past due at which a reminder goes out (reminders_stage in the migration). */
export const STAGES = [1, 7, 14, 30] as const;
export const MAX_ATTEMPTS = 8;
/** How long a claim holds a reminder before another sender may retry it. */
export const LEASE_SECONDS = 300;

const TENANT = "NULLIF(current_setting('app.organization_id', true), '')::uuid";

/**
 * Queues, for every open invoice of the transaction's organization that is past due, the highest stage it has reached
 * and has no reminder at or above: an invoice 20 days overdue with none sent gets the 14-day one (one email, not
 * three). Idempotent: running it twice queues nothing new. Returns how many it queued.
 */
export async function queueDueReminders(tx: TenantTx): Promise<number> {
  return tx.$executeRawUnsafe(`
    INSERT INTO reminders (organization_id, invoice_id, stage)
    SELECT i.organization_id, i.id, s.stage
      FROM invoices i
      CROSS JOIN LATERAL (
        SELECT max(stage) AS stage FROM unnest('{${STAGES.join(",")}}'::smallint[]) AS stage
         WHERE i.due_on + stage <= (clock_timestamp() AT TIME ZONE 'UTC')::date
      ) s
     WHERE i.organization_id = ${TENANT} AND i.status = 'OPEN' AND s.stage IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM reminders r
                        WHERE r.organization_id = i.organization_id AND r.invoice_id = i.id AND r.stage >= s.stage)
     ORDER BY i.id
    ON CONFLICT DO NOTHING`);
}

export interface ClaimedReminder {
  id: string;
  invoiceId: string;
  stage: number;
  recipient: string;
  attempts: number;
  invoiceNumber: number;
  totalMinor: bigint;
  currency: string;
  dueOn: Date;
  customerName: string;
  organizationName: string;
  /** A live payment link for the invoice, if there is one. */
  checkoutUrl: string | null;
}

/**
 * Claims up to `limit` unsent reminders whose next attempt is due, for invoices that are still open: each claim counts
 * an attempt and pushes the next one out by the lease, in this transaction, so once it commits no other sender takes
 * them (and SKIP LOCKED keeps two senders claiming at once from waiting on each other or taking the same rows).
 */
export async function claimReminders(tx: TenantTx, limit = 50): Promise<ClaimedReminder[]> {
  return tx.$queryRawUnsafe<ClaimedReminder[]>(
    `WITH claimed AS (
       UPDATE reminders r
          SET attempts = r.attempts + 1, next_attempt_at = clock_timestamp() + make_interval(secs => ${LEASE_SECONDS})
         FROM (SELECT r2.id FROM reminders r2
                 JOIN invoices i ON i.organization_id = r2.organization_id AND i.id = r2.invoice_id
                WHERE r2.organization_id = ${TENANT} AND r2.sent_at IS NULL AND r2.attempts < ${MAX_ATTEMPTS}
                  AND r2.next_attempt_at <= clock_timestamp() AND i.status = 'OPEN'
                ORDER BY r2.next_attempt_at, r2.id
                LIMIT $1
                  FOR UPDATE OF r2 SKIP LOCKED) c
        WHERE r.id = c.id
       RETURNING r.id, r.invoice_id, r.stage, r.recipient, r.attempts
     )
     SELECT c.id, c.invoice_id AS "invoiceId", c.stage::int AS stage, c.recipient, c.attempts,
            i.number AS "invoiceNumber", i.total_minor AS "totalMinor", i.currency, i.due_on AS "dueOn",
            i.bill_to_name AS "customerName", o.name AS "organizationName",
            (SELECT p.checkout_url FROM payments p
              WHERE p.organization_id = i.organization_id AND p.invoice_id = i.id AND p.status = 'PENDING'
                AND p.expires_at > clock_timestamp() + interval '1 hour'
              ORDER BY p.created_at DESC LIMIT 1) AS "checkoutUrl"
       FROM claimed c
       JOIN invoices i ON i.organization_id = ${TENANT} AND i.id = c.invoice_id
       JOIN organizations o ON o.id = i.organization_id
      ORDER BY c.id`,
    limit,
  );
}

/** Records a claimed reminder as sent (the trigger stamps the time; a second record is refused). */
export async function markSent(tx: TenantTx, id: string): Promise<void> {
  await tx.$executeRawUnsafe(`UPDATE reminders SET sent_at = clock_timestamp() WHERE organization_id = ${TENANT} AND id = $1::uuid AND sent_at IS NULL`, id);
}

/** Seconds until the next attempt after `attempts` failed ones: 5 min, doubling, at most 6 h. */
export function backoffSeconds(attempts: number): number {
  return Math.min(LEASE_SECONDS * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

/** Records a failed send: the error (cut to 500 characters, whole code points) and when to try again. */
export async function markFailed(tx: TenantTx, id: string, attempts: number, error: string): Promise<void> {
  const message = Array.from(error).slice(0, 500).join("");
  await tx.$executeRawUnsafe(
    `UPDATE reminders SET last_error = $2, next_attempt_at = clock_timestamp() + make_interval(secs => $3)
      WHERE organization_id = ${TENANT} AND id = $1::uuid AND sent_at IS NULL`,
    id,
    message,
    backoffSeconds(attempts),
  );
}

/** The email for a claimed reminder. */
export function reminderMessage(r: ClaimedReminder, appBaseUrl: string): MailMessage {
  const total = isCurrency(r.currency) ? formatMoney(BigInt(r.totalMinor), r.currency) : `${r.totalMinor} ${r.currency}`;
  const label = invoiceLabel(r.invoiceNumber);
  const days = r.stage === 1 ? "1 day" : `${r.stage} days`;
  const url = r.checkoutUrl ? (r.checkoutUrl.startsWith("/") ? `${appBaseUrl}${r.checkoutUrl}` : r.checkoutUrl) : null;
  const lines = [
    `Hello ${r.customerName},`,
    "",
    `Invoice ${label} from ${r.organizationName} for ${total} was due on ${formatDate(r.dueOn)} and is now ${days} overdue.`,
    ...(url ? ["", `Pay online: ${url}`] : []),
    "",
    `If you have already paid, thank you, and please ignore this reminder.`,
  ];
  return { to: r.recipient, subject: `Reminder: invoice ${label} from ${r.organizationName} is ${days} overdue`, text: lines.join("\n"), idempotencyKey: `reminder-${r.id}` };
}

export interface ReminderView {
  stage: number;
  sentAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export async function listReminders(tx: TenantTx, invoiceId: string): Promise<ReminderView[]> {
  return tx.reminder.findMany({
    where: { invoiceId },
    select: { stage: true, sentAt: true, attempts: true, lastError: true },
    orderBy: { stage: "asc" },
  });
}
