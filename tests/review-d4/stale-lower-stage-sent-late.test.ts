// Review D4: a late run sends a stale lower-stage reminder as well as the highest stage, two emails, one of them wrong.
//
// The bug: queueDueReminders skips the stages a late run missed (only the highest stage reached is queued, "one email,
// not three"), but nothing retires a lower-stage reminder that was queued earlier and never sent. claimReminders
// claims every unsent reminder of an open invoice, whatever its stage, so both go out in the same run.
//
// Scenario: the job queues the 1-day reminder for an invoice (as on day 1) and the worker stops before sending it (a
// crash or deploy between the queue step and the claim). It runs again when the invoice is 30 days overdue.
//
// Expected: one email, the 30-day reminder (the rule the "late run" test states for queueing).
// Observed: two emails to the customer in one run: "is now 1 day overdue" and "is now 30 days overdue".
import { afterAll, expect, it } from "vitest";
import { MemoryMailer } from "@/server/mail/mailer";
import { runReminderJob } from "@/server/reminders/job";
import { queueDueReminders } from "@/server/reminders/service";
import { db, openInvoice, world } from "../fixtures/org";
import { adminDb } from "../helpers";

const admin = adminDb({ max: 2 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), admin.$disconnect()]);
});

async function overdue(invoiceId: string, days: number): Promise<void> {
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - ${days}::int WHERE id = ${invoiceId}::uuid`;
  });
}

it("sends only the highest stage when a lower one queued earlier was never sent", async () => {
  const org = await world("stale");
  const id = await openInvoice(org);
  await overdue(id, 1);
  // Day 1: the job's queue step ran, then the worker stopped before claiming.
  expect(await org.run((tx) => queueDueReminders(tx))).toBe(1);
  // Day 30: the worker is back.
  await overdue(id, 30);
  const mailer = new MemoryMailer();
  await runReminderJob({ forEachOrganization: (fn) => fn(org.organizationId, org.run), mailer, appBaseUrl: "https://tally.example" });
  expect(mailer.sent.map((m) => m.subject)).toEqual([expect.stringContaining("is 30 days overdue")]);
});
