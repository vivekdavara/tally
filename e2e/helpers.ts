import { expect, type Page } from "@playwright/test";

// Shared steps for the day-4 specs (roles, invitations, reminders).

export function person(prefix = "ada") {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return { name: `${prefix} ${id}`, email: `${prefix}-${id}@example.com`, password: "analytical engine", organization: `${prefix} works ${id}` };
}

export type Person = ReturnType<typeof person>;

/** Signs up (a new user with their own organization) and returns that organization's path, /o/<slug>. */
export async function signUp(page: Page, who: Person): Promise<string> {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel(/^Password/).fill(who.password);
  await page.getByLabel("Organization name").fill(who.organization);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { level: 1, name: who.organization })).toBeVisible();
  return new URL(page.url()).pathname;
}

/** A customer with this email and a draft invoice for it with one $120.00 line; returns the invoice's path. */
export async function draftInvoice(page: Page, orgPath: string, customerEmail: string): Promise<string> {
  await page.goto(`${orgPath}/customers`);
  const customer = page.getByTestId("new-customer");
  await customer.getByLabel("Name").fill("Analytical Customer");
  await customer.getByLabel("Email").fill(customerEmail);
  await customer.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByTestId("customers").getByText(customerEmail)).toBeVisible();
  await page.goto(`${orgPath}/invoices`);
  await page.getByTestId("new-invoice").getByRole("button", { name: "Create draft" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Draft");
  const line = page.getByTestId("add-line");
  await line.getByLabel("Description").fill("Difference engine");
  await line.getByLabel(/^Unit price/).fill("120.00");
  await line.getByRole("button", { name: "Add line" }).click();
  await expect(page.getByTestId("total")).toHaveText("$120.00");
  return new URL(page.url()).pathname;
}

export async function finalize(page: Page, netDays = "30") {
  const form = page.getByTestId("finalize");
  await form.getByLabel("Payment due in (days)").fill(netDays);
  await form.getByRole("button", { name: "Finalize invoice" }).click();
  await expect(page.getByTestId("invoice-title")).toContainText("Open");
}
