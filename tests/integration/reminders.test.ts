// Overdue reminders (DESIGN.md, "Overdue reminders"): which invoices get one and at which stage, sending exactly once
// per stage (also with two workers at once), retries with backoff, a lapsed claim after a crash, giving up, and the
// rules the reminders_guard trigger keeps for any writer. Time passing is simulated by moving an invoice's due date
// back as a superuser with triggers off: nothing the application can do.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { MemoryMailer, type MailMessage } from "@/server/mail/mailer";
import { runReminderJob, type ReminderJobDeps } from "@/server/reminders/job";
import { backoffSeconds, claimReminders, listReminders, MAX_ATTEMPTS, queueDueReminders } from "@/server/reminders/service";
import { markPaid } from "@/server/invoices/service";
import { db, openInvoice, sessions, world, type World } from "../fixtures/org";
import { adminDb, appDb } from "../helpers";

vi.mock("@/auth", () => ({ auth: async () => sessions.current }));

const admin = adminDb({ max: 2 });
const app = appDb({ max: 4 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), admin.$disconnect(), app.$disconnect()]);
});

let w: World;
beforeAll(async () => {
  w = await world("remind");
});

/** Makes the invoice `days` past due today (UTC), as if that much time had passed since it was issued. */
async function overdue(invoiceId: string, days: number): Promise<void> {
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - ${days}::int WHERE id = ${invoiceId}::uuid`;
  });
}

/** Moves every pending reminder's next attempt to now (the backoff or lease has passed). */
async function timePasses(invoiceId: string): Promise<void> {
  await admin.$executeRaw`UPDATE reminders SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE invoice_id = ${invoiceId}::uuid AND sent_at IS NULL`;
}

const only = (org: World): ReminderJobDeps["forEachOrganization"] => (fn) => fn(org.organizationId, org.run);
const job = (mailer: MemoryMailer, org = w, extra: Partial<ReminderJobDeps> = {}) =>
  runReminderJob({ forEachOrganization: only(org), mailer, appBaseUrl: "https://tally.example", ...extra });
const reminders = (invoiceId: string, org = w) => org.run((tx) => listReminders(tx, invoiceId));

describe("queueing", () => {
  it("queues nothing for an invoice that isn't overdue, a draft, or a paid one", async () => {
    const notYet = await openInvoice(w, 0);
    const paid = await openInvoice(w);
    await overdue(paid, 10);
    await w.run((tx) => markPaid(tx, paid));
    await w.run((tx) => queueDueReminders(tx));
    expect([await reminders(notYet), await reminders(paid)]).toEqual([[], []]);
  });

  it("queues the highest stage reached, once, and later stages as they come", async () => {
    const id = await openInvoice(w);
    await overdue(id, 1);
    await w.run((tx) => queueDueReminders(tx));
    await w.run((tx) => queueDueReminders(tx));
    expect((await reminders(id)).map((r) => r.stage)).toEqual([1]);
    await overdue(id, 9);
    await w.run((tx) => queueDueReminders(tx));
    expect((await reminders(id)).map((r) => r.stage)).toEqual([1, 7]);
  });

  it("skips stages a late run missed: 20 days overdue with none sent is one reminder, the 14-day one", async () => {
    const id = await openInvoice(w);
    await overdue(id, 20);
    await w.run((tx) => queueDueReminders(tx));
    expect((await reminders(id)).map((r) => r.stage)).toEqual([14]);
    await overdue(id, 45);
    await w.run((tx) => queueDueReminders(tx));
    expect((await reminders(id)).map((r) => r.stage)).toEqual([14, 30]);
    await w.run((tx) => queueDueReminders(tx));
    expect(await reminders(id)).toHaveLength(2);
  });
});

describe("the job", () => {
  it("sends each queued reminder once, to the invoice's bill-to address, and records it", async () => {
    const org = await world("send");
    const id = await openInvoice(org);
    await overdue(id, 7);
    const mailer = new MemoryMailer();
    expect(await job(mailer, org)).toMatchObject({ queued: 1, sent: 1, failed: 0, errors: [] });
    expect(await job(mailer, org)).toMatchObject({ queued: 0, sent: 0 });
    expect(mailer.sent).toHaveLength(1);
    const [message] = mailer.sent as [MailMessage];
    const billTo = (await org.run((tx) => tx.invoice.findUniqueOrThrow({ where: { id }, select: { billToEmail: true, number: true } })));
    expect(message.to).toBe(billTo.billToEmail);
    expect(message.subject).toBe(`Reminder: invoice INV-${String(billTo.number).padStart(4, "0")} from ${org.name} is 7 days overdue`);
    expect(message.text).toContain("for $10.00 was due on");
    expect(message.text).not.toContain("Pay online");
    const [r] = await reminders(id, org);
    expect(r).toMatchObject({ stage: 7, attempts: 1, lastError: null });
    expect(r!.sentAt).toBeInstanceOf(Date);
  });

  it("includes a live payment link", async () => {
    const org = await world("link");
    const id = await openInvoice(org);
    await overdue(id, 1);
    const url = `/mock-checkout/cs_test_${Date.now()}`;
    const amount = (await org.run((tx) => tx.invoice.findUniqueOrThrow({ where: { id } }))).totalMinor!;
    await org.run((tx) =>
      tx.payment.create({
        data: { organizationId: org.organizationId, invoiceId: id, provider: "mock", checkoutSessionId: `cs_test_${Date.now()}`, checkoutUrl: url, amountMinor: amount, currency: "USD", expiresAt: new Date(Date.now() + 86_400_000) },
      }),
    );
    const mailer = new MemoryMailer();
    await job(mailer, org);
    expect(mailer.sent[0]!.text).toContain(`Pay online: https://tally.example${url}`);
  });

  it("retries a failed send with backoff, and gives up after the last attempt", async () => {
    const org = await world("retry");
    const id = await openInvoice(org);
    await overdue(id, 1);
    const mailer = new MemoryMailer();
    mailer.failWith = () => new Error("mail provider said 503");
    expect(await job(mailer, org)).toMatchObject({ queued: 1, sent: 0, failed: 1 });
    const [first] = await admin.$queryRaw<{ attempts: number; last_error: string; wait: number }[]>`
      SELECT attempts, last_error, extract(epoch FROM next_attempt_at - clock_timestamp())::float AS wait FROM reminders WHERE invoice_id = ${id}::uuid`;
    expect(first).toMatchObject({ attempts: 1, last_error: "mail provider said 503" });
    expect(first!.wait).toBeGreaterThan(backoffSeconds(1) - 5);
    // Not due yet: nothing is tried.
    expect(await job(mailer, org)).toMatchObject({ sent: 0, failed: 0 });
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      await timePasses(id);
      expect(await job(mailer, org)).toMatchObject({ failed: 1 });
    }
    await timePasses(id);
    mailer.failWith = null;
    expect(await job(mailer, org)).toMatchObject({ sent: 0, failed: 0 });
    expect(await reminders(id, org)).toEqual([{ stage: 1, sentAt: null, attempts: MAX_ATTEMPTS, lastError: "mail provider said 503" }]);
  });

  it("backs off 5, 10, 20 ... minutes, at most 6 hours", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffSeconds)).toEqual([300, 600, 1200, 2400, 4800, 9600, 19200, 21600]);
  });

  it("retries a claim that was never recorded (a crash after sending) once the lease lapses, with the same key", async () => {
    const org = await world("crash");
    const id = await openInvoice(org);
    await overdue(id, 1);
    await org.run((tx) => queueDueReminders(tx));
    // A sender claims it, then dies before sending or recording.
    expect(await org.run((tx) => claimReminders(tx))).toHaveLength(1);
    const mailer = new MemoryMailer();
    expect(await job(mailer, org)).toMatchObject({ sent: 0 });
    await timePasses(id);
    expect(await job(mailer, org)).toMatchObject({ sent: 1 });
    const [r] = await admin.$queryRaw<{ id: string; attempts: number }[]>`SELECT id, attempts FROM reminders WHERE invoice_id = ${id}::uuid`;
    expect(mailer.sent.map((m) => m.idempotencyKey)).toEqual([`reminder-${r!.id}`]);
    expect(r!.attempts).toBe(2);
  });

  it("sends exactly once per reminder with two workers running at the same time", async () => {
    const org = await world("pair");
    const ids = await Promise.all(Array.from({ length: 12 }, () => openInvoice(org)));
    await Promise.all(ids.map((id) => overdue(id, 7)));
    const mailer = new MemoryMailer();
    mailer.beforeAccept = () => new Promise((r) => setTimeout(r, 15));
    const reports = await Promise.all([job(mailer, org, { batchSize: 3 }), job(mailer, org, { batchSize: 3 })]);
    expect(reports.reduce((n, r) => n + r.sent, 0)).toBe(12);
    expect(reports.flatMap((r) => r.errors)).toEqual([]);
    const keys = mailer.sent.map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(12);
    expect(keys).toHaveLength(12);
    // Both did some of the sending (each batch is claimed with SKIP LOCKED, so neither waited for the other).
    expect(reports.every((r) => r.sent > 0)).toBe(true);
  });

  it("doesn't send a queued reminder once the invoice is paid", async () => {
    const org = await world("paidlate");
    const id = await openInvoice(org);
    await overdue(id, 1);
    await org.run((tx) => queueDueReminders(tx));
    await org.run((tx) => markPaid(tx, id));
    const mailer = new MemoryMailer();
    expect(await job(mailer, org)).toMatchObject({ sent: 0 });
    expect(mailer.sent).toEqual([]);
  });

  it("goes on to the next organization when one fails, and reports it", async () => {
    const a = await world("fa");
    const b = await world("fb");
    const idB = await openInvoice(b);
    await overdue(idB, 1);
    const mailer = new MemoryMailer();
    const report = await runReminderJob({
      forEachOrganization: async (fn) => {
        await fn(a.organizationId, () => Promise.reject(new Error("connection reset")));
        await fn(b.organizationId, b.run);
      },
      mailer,
      appBaseUrl: "https://tally.example",
    });
    expect(report).toMatchObject({ organizations: 2, sent: 1 });
    expect(report.errors.map((e) => [e.organizationId, e.step])).toEqual([
      [a.organizationId, "queue"],
      [a.organizationId, "claim"],
    ]);
  });

  it("runs over every organization through the data access layer, each in its own tenant", async () => {
    const { forEachOrganization } = await import("@/server/dal");
    const seen: string[] = [];
    const others = new Set<string>();
    await forEachOrganization(async (organizationId, run) => {
      seen.push(organizationId);
      // Row security limits each run to its organization.
      for (const c of await run((tx) => tx.customer.findMany({ select: { organizationId: true } }))) others.add(c.organizationId === organizationId ? "same" : "other");
    });
    expect(seen).toContain(w.organizationId);
    expect(new Set(seen).size).toBe(seen.length);
    expect(others).toEqual(new Set(["same"]));
    const total = await admin.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM organizations`;
    expect(BigInt(seen.length)).toBe(total[0]!.n);
  });
});

describe("the reminders_guard trigger", () => {
  const raw = (sql: string, ...params: unknown[]) => withTenant(w.organizationId, (tx) => tx.$executeRawUnsafe(sql, ...params), app);

  it("refuses a reminder for an invoice that isn't that overdue, or isn't open", async () => {
    const id = await openInvoice(w);
    await overdue(id, 3);
    await expect(raw(`INSERT INTO reminders (organization_id, invoice_id, stage) VALUES ($1::uuid, $2::uuid, 7)`, w.organizationId, id)).rejects.toThrow(/isn't due that reminder/);
    await raw(`INSERT INTO reminders (organization_id, invoice_id, stage) VALUES ($1::uuid, $2::uuid, 1)`, w.organizationId, id);
    await w.run((tx) => markPaid(tx, id));
    const other = await openInvoice(w);
    await overdue(other, 30);
    await w.run((tx) => markPaid(tx, other));
    await expect(raw(`INSERT INTO reminders (organization_id, invoice_id, stage) VALUES ($1::uuid, $2::uuid, 1)`, w.organizationId, other)).rejects.toThrow(/isn't due that reminder/);
  });

  it("addresses it to the invoice's bill-to email whatever the writer says, and records sending once", async () => {
    const id = await openInvoice(w);
    await overdue(id, 1);
    // recipient isn't even granted: the app can't choose it.
    await expect(raw(`INSERT INTO reminders (organization_id, invoice_id, stage, recipient) VALUES ($1::uuid, $2::uuid, 1, 'attacker@example.com')`, w.organizationId, id)).rejects.toThrow(
      /permission denied/,
    );
    await raw(`INSERT INTO reminders (organization_id, invoice_id, stage) VALUES ($1::uuid, $2::uuid, 1)`, w.organizationId, id);
    const [r] = await admin.$queryRaw<{ id: string; recipient: string; bill: string }[]>`
      SELECT r.id, r.recipient, i.bill_to_email AS bill FROM reminders r JOIN invoices i ON i.id = r.invoice_id WHERE r.invoice_id = ${id}::uuid`;
    expect(r!.recipient).toBe(r!.bill);
    await raw(`UPDATE reminders SET sent_at = clock_timestamp() WHERE id = $1::uuid`, r!.id);
    await expect(raw(`UPDATE reminders SET sent_at = clock_timestamp() WHERE id = $1::uuid`, r!.id)).rejects.toThrow(/already sent/);
    await expect(raw(`UPDATE reminders SET recipient = 'x@example.com' WHERE id = $1::uuid`, r!.id)).rejects.toThrow(/permission denied/);
    await expect(raw(`DELETE FROM reminders WHERE id = $1::uuid`, r!.id)).rejects.toThrow(/permission denied/);
  });

  it("can't reference another organization's invoice", async () => {
    const other = await world("foreign");
    const id = await openInvoice(other);
    await overdue(id, 30);
    // As organization w, naming other's invoice: the composite key finds no such invoice in w.
    await expect(raw(`INSERT INTO reminders (organization_id, invoice_id, stage) VALUES ($1::uuid, $2::uuid, 1)`, w.organizationId, id)).rejects.toThrow(
      /isn't due that reminder|reminders_organization_id_invoice_id_fkey/,
    );
    // Naming other's organization: row security refuses the row.
    await expect(raw(`INSERT INTO reminders (organization_id, invoice_id, stage) VALUES ($1::uuid, $2::uuid, 1)`, other.organizationId, id)).rejects.toThrow(/row-level security|isn't due/);
    expect(await reminders(id, other)).toEqual([]);
  });
});
