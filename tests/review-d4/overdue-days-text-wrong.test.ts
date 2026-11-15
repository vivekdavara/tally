// Review D4: a reminder's email states the stage as the number of days overdue, which is false for a late run.
//
// The bug: reminderMessage writes "is now ${stage} days overdue" (and the subject "is ${stage} days overdue"). The
// stage is the highest threshold reached, not how overdue the invoice is: a late run that queues the 14-day reminder
// for an invoice 20 days past due (the case tests/integration/reminders.test.ts names) tells the customer it is 14 days
// overdue, and a retried reminder (backoff up to 6 h per attempt, 8 attempts) can go out a day later than its stage.
//
// Scenario: an open invoice 20 days past due, no reminder sent yet; the job runs.
// Expected: the email says the invoice is 20 days overdue (or at least doesn't state a wrong count).
// Observed: "is now 14 days overdue".
import { afterAll, expect, it } from "vitest";
import { MemoryMailer } from "@/server/mail/mailer";
import { runReminderJob } from "@/server/reminders/job";
import { db, openInvoice, world } from "../fixtures/org";
import { adminDb } from "../helpers";

const admin = adminDb({ max: 2 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), admin.$disconnect()]);
});

it("tells the customer how many days overdue the invoice actually is", async () => {
  const org = await world("days");
  const id = await openInvoice(org);
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - 20 WHERE id = ${id}::uuid`;
  });
  const mailer = new MemoryMailer();
  await runReminderJob({ forEachOrganization: (fn) => fn(org.organizationId, org.run), mailer, appBaseUrl: "https://tally.example" });
  expect(mailer.sent).toHaveLength(1);
  expect(mailer.sent[0]!.text).not.toContain("is now 14 days overdue");
  expect(mailer.sent[0]!.text).toContain("20 days overdue");
});
