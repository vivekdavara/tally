import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { draftInvoice, finalize, person, signUp } from "./helpers";

// Day 4's background job end to end: an invoice finalized in the browser becomes 7 days overdue (its due date moved
// back by a superuser: time passing is the one thing the test fakes), `npm run worker -- --once` runs against the
// same database and prints the reminder it sent, and the invoice page shows it sent. A second pass sends nothing.

function runWorkerOnce(): { mail: { to: string; subject: string; text: string; idempotencyKey: string } }[] {
  const out = execFileSync("node_modules/.bin/tsx", ["scripts/worker.ts", "--once"], {
    env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL, APP_BASE_URL: "http://localhost:8117", BILLING_PROVIDER: "mock" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return out
    .split("\n")
    .filter((line) => line.startsWith('{"mail"'))
    .map((line) => JSON.parse(line));
}

test("an overdue invoice gets one reminder from the worker, shown on its page", async ({ page }) => {
  const customerEmail = `late-payer-${Date.now()}@example.com`;
  const orgPath = await signUp(page, person("grace"));
  const invoicePath = await draftInvoice(page, orgPath, customerEmail);
  await finalize(page, "0");
  const invoiceId = invoicePath.split("/").at(-1)!;

  const admin = new pg.Client({ connectionString: process.env.E2E_ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query("UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - 7 WHERE id = $1", [invoiceId]);
    await admin.query("COMMIT");
  } finally {
    await admin.end();
  }

  const mine = (mails: ReturnType<typeof runWorkerOnce>) => mails.filter((m) => m.mail.to === customerEmail);
  const sent = mine(runWorkerOnce());
  expect(sent).toHaveLength(1);
  expect(sent[0]!.mail.subject).toMatch(/^Reminder: invoice INV-0001 from grace works .+ is 7 days overdue$/);
  expect(sent[0]!.mail.text).toContain("for $120.00 was due on");
  expect(mine(runWorkerOnce())).toEqual([]);

  await page.goto(invoicePath);
  const row = page.getByTestId("reminders").locator('tr[data-stage="7"]');
  await expect(row).toHaveAttribute("data-sent", "yes");
  await expect(row).toContainText(customerEmail);
  await expect(row).toContainText(/Sent [A-Z][a-z]{2} \d{1,2}, \d{4}/);
});
