import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

// A session cookie can outlive its user (JWTs can't be revoked). The pages must treat it as signed out,
// not bounce between /signin ("you have a session, go to /o") and /o ("no such user, go to /signin").
test("a session whose user was deleted lands on the sign-in form, not in a redirect loop", async ({ page }) => {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = `stale-${id}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Stale");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel(/^Password/).fill("analytical engine");
  await page.getByLabel("Organization name").fill(`Stale ${id}`);
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Stale ${id}` })).toBeVisible();

  // Delete the user behind the browser's back, as an administrator would.
  execFileSync("psql", ["-X", "-q", "-d", process.env.E2E_DATABASE_URL!, "-c", `DELETE FROM users WHERE email = '${email}'`]);

  for (const path of ["/o", "/signin", "/signup"]) {
    const response = await page.goto(path);
    expect(response?.ok(), path).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(path === "/signup" ? "Create an organization" : "Sign in");
  }
});
