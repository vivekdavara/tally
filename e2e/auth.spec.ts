import { expect, test, type Page } from "@playwright/test";

function person() {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: `Ada ${id}`,
    email: `ada-${id}@example.com`,
    password: "analytical engine",
    organization: `Engines ${id}`,
  };
}

async function signUp(page: Page, who: ReturnType<typeof person>) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel(/^Password/).fill(who.password);
  await page.getByLabel("Organization name").fill(who.organization);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { level: 1, name: who.organization })).toBeVisible();
}

test("sign up lands on the new organization, then sign out and back in", async ({ page }) => {
  const who = person();
  await signUp(page, who);
  await expect(page).toHaveURL(new RegExp(`/o/engines-${who.organization.split(" ")[1]}$`));
  await expect(page.getByText(`Signed in as ${who.name} (${who.email}), owner.`)).toBeVisible();
  await expect(page.getByTestId("customer-count")).toHaveText("0");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/o");
  await expect(page).toHaveURL(/\/signin/);

  await page.getByLabel("Email").fill(who.email.toUpperCase());
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: who.organization })).toBeVisible();
});

test("a wrong password and an unknown email get the same answer", async ({ page }) => {
  const who = person();
  await signUp(page, who);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  for (const attempt of [
    { email: who.email, password: "not the password" },
    { email: `nobody-${who.email}`, password: who.password },
  ]) {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(attempt.email);
    await page.getByLabel("Password").fill(attempt.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Scoped to the form: Next.js's route announcer is an (empty) role="alert" too.
    await expect(page.locator("form").getByRole("alert")).toHaveText("Wrong email or password.");
    await expect(page.getByLabel("Email")).toHaveValue(attempt.email);
  }
});

test("sign-up shows each field's problem and keeps what was typed, except the password", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Ada");
  await page.getByLabel("Email").fill("not-an-email");
  await page.getByLabel(/^Password/).fill("short");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
  await expect(page.getByText("Enter an organization name.")).toBeVisible();
  await expect(page.getByLabel("Your name")).toHaveValue("Ada");
  await expect(page.getByLabel("Email")).toHaveValue("not-an-email");
  await expect(page.getByLabel(/^Password/)).toHaveValue("");
});

test("an email that already has an account is refused", async ({ page, browser }) => {
  const who = person();
  await signUp(page, who);
  const other = await browser.newContext();
  const second = await other.newPage();
  await second.goto("/signup");
  await second.getByLabel("Your name").fill("Someone Else");
  await second.getByLabel("Email").fill(who.email);
  await second.getByLabel(/^Password/).fill("a different password");
  await second.getByLabel("Organization name").fill("Another Org");
  await second.getByRole("button", { name: "Create organization" }).click();
  await expect(second.getByText("An account with this email already exists.")).toBeVisible();
  await other.close();
});

test("another organization's page is a 404, the same as one that doesn't exist", async ({ page, browser }) => {
  const owner = person();
  await signUp(page, owner);
  const slug = new URL(page.url()).pathname.split("/").at(-1)!;

  const other = await browser.newContext();
  const outsider = await other.newPage();
  await signUp(outsider, person());
  const foreign = await outsider.goto(`/o/${slug}`);
  const missing = await outsider.goto(`/o/${slug}-does-not-exist`);
  expect(foreign?.status()).toBe(404);
  expect(missing?.status()).toBe(404);
  await expect(outsider.getByText(owner.organization)).toHaveCount(0);
  await other.close();
});
