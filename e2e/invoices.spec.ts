import { expect, test, type Page } from "@playwright/test";

// The day-2 flow in a browser: a customer, a draft with lines (exact totals on the page), finalization to
// INV-0001, then paid; and another organization's invoice is a 404 like a missing one.

function person() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return { name: `Grace ${id}`, email: `grace-${id}@example.com`, password: "compiler compiler", organization: `Cobol ${id}` };
}

async function signUp(page: Page, who: ReturnType<typeof person>): Promise<string> {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel(/^Password/).fill(who.password);
  await page.getByLabel("Organization name").fill(who.organization);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { level: 1, name: who.organization })).toBeVisible();
  return new URL(page.url()).pathname;
}

async function addLine(page: Page, line: { description: string; quantity: string; unitPrice: string; taxRate: string }) {
  const form = page.getByTestId("add-line");
  await form.getByLabel("Description").fill(line.description);
  await form.getByLabel("Quantity").fill(line.quantity);
  await form.getByLabel(/^Unit price/).fill(line.unitPrice);
  await form.getByLabel("Tax rate (%)").fill(line.taxRate);
  await form.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByTestId("lines").getByRole("cell", { name: line.description, exact: true })).toBeVisible();
}

async function newInvoice(page: Page, orgPath: string): Promise<string> {
  await page.goto(`${orgPath}/customers`);
  const form = page.getByTestId("new-customer");
  await form.getByLabel("Name").fill("Navy Yard");
  await form.getByLabel("Email").fill("Payables@Navy.example");
  await form.getByLabel(/^Address/).fill("1 Dock St\nWashington, DC");
  await form.getByRole("button", { name: "Add customer" }).click();
  // Stored in lower case, like every email.
  await expect(page.getByTestId("customers").getByText("payables@navy.example")).toBeVisible();

  await page.goto(`${orgPath}/invoices`);
  await page.getByTestId("new-invoice").getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Draft");
  return new URL(page.url()).pathname;
}

test("a draft with lines is finalized to INV-0001 with exact totals, then paid", async ({ page }) => {
  const orgPath = await signUp(page, person());
  await newInvoice(page, orgPath);

  // 1.5 x $3.33 = $4.995 → $5.00; 2 x $19.99 = $39.98; tax per rate: 8.875% of $5.00 = $0.44375 → $0.44,
  // 20% of $39.98 = $7.996 → $8.00.
  await addLine(page, { description: "Consulting", quantity: "1.5", unitPrice: "3.33", taxRate: "8.875" });
  await addLine(page, { description: "Licences", quantity: "2", unitPrice: "19.99", taxRate: "20" });
  await expect(page.getByTestId("subtotal")).toHaveText("$44.98");
  await expect(page.getByTestId("total")).toHaveText("$53.42");

  // A price with more decimals than the currency has is refused, not rounded, and the typed values stay.
  const form = page.getByTestId("add-line");
  await form.getByLabel("Description").fill("Too precise");
  await form.getByLabel(/^Unit price/).fill("1.005");
  await form.getByRole("button", { name: "Add line" }).click();
  await expect(form.getByText("Price can have at most 2 decimals")).toBeVisible();
  await expect(form.getByLabel(/^Unit price/)).toHaveValue("1.005");

  await page.getByTestId("finalize").getByRole("button", { name: "Finalize invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("INV-0001");
  await expect(page.getByTestId("invoice-title")).toContainText("Open");
  await expect(page.getByTestId("total")).toHaveText("$53.42");
  await expect(page.getByTestId("add-line")).toHaveCount(0);

  // The PDF, with the session's cookies: the number and the same exact total.
  const pdf = await page.request.get((await page.getByTestId("pdf-link").getAttribute("href"))!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toBe('inline; filename="INV-0001.pdf"');
  expect(pdf.headers()["cache-control"]).toBe("private, no-store");
  const bytes = (await pdf.body()).toString("latin1");
  expect(bytes.startsWith("%PDF-1.4")).toBe(true);
  expect(bytes).toContain("(INV-0001) Tj");
  expect(bytes).toContain("($53.42) Tj");

  await page.getByTestId("mark-paid").getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Paid");

  await page.goto(`${orgPath}/invoices`);
  await expect(page.getByTestId("invoices").getByRole("row", { name: /INV-0001 Navy Yard Paid/ })).toContainText("$53.42");
});

test("finalizing an empty draft says why, and the draft stays a draft", async ({ page }) => {
  const orgPath = await signUp(page, person());
  await newInvoice(page, orgPath);
  await page.getByTestId("finalize").getByRole("button", { name: "Finalize invoice" }).click();
  await expect(page.getByTestId("finalize").getByRole("alert")).toHaveText("Add at least one line before finalizing.");
  await expect(page.getByTestId("invoice-title")).toContainText("Draft");
});

test("another organization's invoice and customer are 404s, like missing ones", async ({ browser }) => {
  const owner = await browser.newPage();
  const ownerOrg = await signUp(owner, person());
  const invoicePath = await newInvoice(owner, ownerOrg);
  const customerHref = await (async () => {
    await owner.goto(`${ownerOrg}/customers`);
    return owner.getByTestId("customers").getByRole("link", { name: "Navy Yard" }).getAttribute("href");
  })();

  const other = await browser.newContext().then((c) => c.newPage());
  const otherOrg = await signUp(other, person());
  const invoiceId = invoicePath.split("/").at(-1)!;
  const customerId = customerHref!.split("/").at(-1)!;
  // The other organization's own URLs with this organization's ids: row-level security hides the rows.
  for (const path of [`${otherOrg}/invoices/${invoiceId}`, `${otherOrg}/customers/${customerId}`, `${otherOrg}/invoices/${crypto.randomUUID()}`]) {
    const response = await other.goto(path);
    expect(response?.status(), path).toBe(404);
  }
  // The PDF route too: the other organization's slug with this invoice's id, and this organization's own.
  expect((await other.request.get(`${otherOrg}/invoices/${invoiceId}/pdf`)).status()).toBe(404);
  expect((await other.request.get(`${invoicePath}/pdf`)).status()).toBe(404);
  // And the owner's URLs: not a member, so a 404 before any query.
  expect((await other.goto(invoicePath))?.status()).toBe(404);
  // Signed out, the PDF route sends you to sign in rather than serving anything.
  const anonymous = await browser.newContext().then((c) => c.newPage());
  const signedOut = await anonymous.request.get(`${invoicePath}/pdf`, { maxRedirects: 0 });
  expect(signedOut.status()).toBe(307);
  expect(signedOut.headers()["location"]).toMatch(/\/signin$/);
});

test("customers: a duplicate email is a message, edits keep issued invoices as issued, and deletes are guarded", async ({ page }) => {
  const orgPath = await signUp(page, person());
  const invoicePath = await newInvoice(page, orgPath);

  // The same email again (in another case): refused with a message, the typed values kept.
  await page.goto(`${orgPath}/customers`);
  const form = page.getByTestId("new-customer");
  await form.getByLabel("Name").fill("Navy Yard again");
  await form.getByLabel("Email").fill("PAYABLES@navy.example");
  await form.getByRole("button", { name: "Add customer" }).click();
  await expect(form.getByRole("alert")).toHaveText("A customer with this email already exists.");
  await expect(form.getByLabel("Name")).toHaveValue("Navy Yard again");

  // Finalize the invoice, then rename the customer: the invoice still shows the name it was issued to.
  await page.goto(invoicePath);
  await addLine(page, { description: "Survey", quantity: "1", unitPrice: "100", taxRate: "0" });
  await page.getByTestId("finalize").getByRole("button", { name: "Finalize invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("INV-0001");
  await page.goto(`${orgPath}/customers`);
  await page.getByTestId("customers").getByRole("link", { name: "Navy Yard" }).click();
  const edit = page.getByTestId("edit-customer");
  await edit.getByLabel("Name").fill("Navy Yard (renamed)");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("customers").getByRole("link", { name: "Navy Yard (renamed)" })).toBeVisible();
  await page.goto(invoicePath);
  await expect(page.getByText("To Navy Yard (", { exact: false })).toContainText("To Navy Yard (payables@navy.example)");

  // A customer with invoices can't be deleted; void the invoice and it still can't (voided invoices stay).
  await page.goto(`${orgPath}/customers`);
  await page.getByTestId("customers").getByRole("link", { name: "Navy Yard (renamed)" }).click();
  await page.getByTestId("delete-customer").getByRole("button", { name: "Delete customer" }).click();
  await expect(page.getByTestId("delete-customer").getByRole("alert")).toHaveText("This customer has invoices, so it can't be deleted.");
  await page.goto(invoicePath);
  await page.getByTestId("void").getByRole("button", { name: "Void invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Void");
  await expect(page.getByTestId("mark-paid")).toHaveCount(0);
});

test("a draft can be deleted; its number is never used", async ({ page }) => {
  const orgPath = await signUp(page, person());
  const first = await newInvoice(page, orgPath);
  await page.goto(first);
  await page.getByTestId("delete-draft").getByRole("button", { name: "Delete draft" }).click();
  await expect(page).toHaveURL(new RegExp(`${orgPath}/invoices$`));
  await expect(page.getByText("No invoices yet.")).toBeVisible();
  expect((await page.goto(first))?.status()).toBe(404);
  // The next invoice finalized is still INV-0001: drafts never had a number to lose.
  await page.goto(`${orgPath}/invoices`);
  await page.getByTestId("new-invoice").getByRole("button", { name: "Create draft" }).click();
  await addLine(page, { description: "Work", quantity: "2", unitPrice: "50", taxRate: "10" });
  await expect(page.getByTestId("total")).toHaveText("$110.00");
  await page.getByTestId("finalize").getByRole("button", { name: "Finalize invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("INV-0001");
});
