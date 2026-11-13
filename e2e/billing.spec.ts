import { createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// Day 3 in a browser: an open invoice gets a payment link, the customer pays on the (mock) hosted checkout page,
// the signed webhook marks the invoice paid, and a redelivered event changes nothing. Then the webhook endpoint over
// real HTTP: unsigned, forged and oversized requests are refused.

function person() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return { name: `Ada ${id}`, email: `ada-${id}@example.com`, password: "analytical engine", organization: `Engines ${id}` };
}

async function openInvoice(page: Page): Promise<string> {
  const who = person();
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel(/^Password/).fill(who.password);
  await page.getByLabel("Organization name").fill(who.organization);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { level: 1, name: who.organization })).toBeVisible();
  const orgPath = new URL(page.url()).pathname;

  await page.goto(`${orgPath}/customers`);
  const customer = page.getByTestId("new-customer");
  await customer.getByLabel("Name").fill("Navy Yard");
  await customer.getByLabel("Email").fill("payables@navy.example");
  await customer.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByTestId("customers").getByText("payables@navy.example")).toBeVisible();

  await page.goto(`${orgPath}/invoices`);
  await page.getByTestId("new-invoice").getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Draft");
  const line = page.getByTestId("add-line");
  await line.getByLabel("Description").fill("Consulting");
  await line.getByLabel(/^Unit price/).fill("53.42");
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByTestId("total")).toHaveText("$53.42");
  await page.getByTestId("finalize").getByRole("button", { name: "Finalize invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Open");
  return new URL(page.url()).pathname;
}

test("an open invoice is paid through its payment link, exactly once", async ({ page }) => {
  const invoicePath = await openInvoice(page);
  await page.getByTestId("collect-payment").getByRole("button", { name: "Create payment link" }).click();
  const link = page.getByTestId("checkout-link");
  await expect(link).toBeVisible();
  await expect(page.getByTestId("payments").locator("tbody tr")).toHaveCount(1);
  // A second click reuses the live link rather than making another.
  await page.getByTestId("collect-payment").getByRole("button", { name: "Create payment link" }).click();
  await expect(page.getByTestId("payments").locator("tbody tr")).toHaveCount(1);

  await link.click();
  await expect(page.getByTestId("checkout-amount")).toHaveText("$53.42");
  await page.getByTestId("pay-card").getByRole("button", { name: "Pay by card" }).click();
  await expect(page.getByTestId("deliveries")).toContainText('"outcome":"invoice-paid"');
  // Stripe retries a delivery it isn't sure arrived; the second one is recognised by its event id.
  await page.getByTestId("redeliver").getByRole("button", { name: "Send the last event again" }).click();
  await expect(page.getByTestId("deliveries").locator("li")).toHaveCount(2);
  await expect(page.getByTestId("deliveries").locator("li").nth(1)).toContainText('"result":"duplicate"');

  await page.goto(invoicePath);
  await expect(page.getByTestId("invoice-title")).toContainText("Paid");
  await expect(page.getByTestId("payments").locator("tbody tr")).toHaveAttribute("data-status", "SUCCEEDED");
  await expect(page.getByTestId("refund-due")).toHaveCount(0);
  await expect(page.getByTestId("collect-payment")).toHaveCount(0);
});

test("voiding an invoice expires its payment link", async ({ page }) => {
  const invoicePath = await openInvoice(page);
  await page.getByTestId("collect-payment").getByRole("button", { name: "Create payment link" }).click();
  const href = (await page.getByTestId("checkout-link").getAttribute("href"))!;
  await page.getByTestId("void").getByRole("button", { name: "Void invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Void");
  await expect(page.getByTestId("payments").locator("tbody tr")).toHaveAttribute("data-status", "EXPIRED");
  await page.goto(href);
  await expect(page.getByTestId("checkout-status")).toHaveText("Session expired, payment unpaid");
  await expect(page.getByTestId("pay-card")).toHaveCount(0);
  await page.goto(invoicePath);
  await expect(page.getByTestId("invoice-title")).toContainText("Void");
});

test.describe("the webhook endpoint over HTTP", () => {
  const secret = process.env.E2E_STRIPE_WEBHOOK_SECRET!;
  const sign = (body: string, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const event = (type: string, object: unknown) =>
    JSON.stringify({ id: `evt_e2e_${Date.now()}${Math.floor(Math.random() * 1e6)}`, object: "event", type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } });

  test("refuses unsigned, forged, stale and oversized requests", async ({ request }) => {
    const body = event("checkout.session.completed", {});
    const post = (data: string, headers: Record<string, string> = {}) => request.post("/api/stripe/webhook", { data, headers: { "content-type": "application/json", ...headers } });
    expect((await post(body)).status()).toBe(400);
    expect((await post(body, { "stripe-signature": sign(`${body} `) })).status()).toBe(400);
    expect((await post(body, { "stripe-signature": sign(body, Math.floor(Date.now() / 1000) - 600) })).status()).toBe(400);
    const big = "x".repeat(300 * 1024);
    const tooLarge = await post(big, { "stripe-signature": sign(big) });
    expect(tooLarge.status()).toBe(413);
  });

  test("acknowledges authentic events it doesn't act on", async ({ request }) => {
    const unhandled = event("customer.created", { id: "cus_1", object: "customer" });
    const a = await request.post("/api/stripe/webhook", { data: unhandled, headers: { "stripe-signature": sign(unhandled), "content-type": "application/json" } });
    expect(a.status()).toBe(200);
    expect(await a.json()).toEqual({ result: "ignored", reason: "unhandled-type" });
    // A session for an organization that doesn't exist: nothing to apply, and retrying won't change that.
    const gone = event("checkout.session.completed", {
      id: "cs_test_gone",
      object: "checkout.session",
      amount_total: 5342,
      currency: "usd",
      payment_status: "paid",
      payment_intent: "pi_test_gone",
      metadata: { organization_id: randomUUID(), invoice_id: randomUUID() },
    });
    const b = await request.post("/api/stripe/webhook", { data: gone, headers: { "stripe-signature": sign(gone), "content-type": "application/json" } });
    expect(await b.json()).toEqual({ result: "ignored", reason: "organization-gone" });
  });

  test("the mock checkout page is a 404 for a session the mock didn't issue", async ({ page }) => {
    const response = await page.goto("/mock-checkout/cs_mock_00000000000000000000000000000000");
    expect(response?.status()).toBe(404);
  });
});
