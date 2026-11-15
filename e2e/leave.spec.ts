import { expect, test } from "@playwright/test";
import { person, signUp } from "./helpers";

// Day 5: a member leaves an organization from its members page, lands on their own list of organizations, and the
// organization is then a 404 for them, as for anyone outside it. Its only owner can't leave.

test("a member leaves and loses access; the only owner can't leave", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const member = await memberContext.newPage();
  const ada = person("ada");
  const grace = person("grace");

  const orgPath = await signUp(owner, ada);
  await owner.goto(`${orgPath}/members`);
  const invite = owner.getByTestId("invite");
  await invite.getByLabel("Email").fill(grace.email);
  await invite.getByRole("button", { name: "Create invitation link" }).click();
  const link = (await owner.getByTestId("invite-notice").textContent())!;

  await signUp(member, grace);
  await member.goto(new URL(link).pathname);
  await member.getByRole("button", { name: "Accept invitation" }).click();
  await expect(member).toHaveURL(new RegExp(`${orgPath}$`));

  // Grace leaves.
  await member.goto(`${orgPath}/members`);
  await member.getByTestId("leave").getByRole("button", { name: "Leave organization" }).click();
  await expect(member).toHaveURL(/\/o$/);
  expect((await member.goto(orgPath))?.status()).toBe(404);

  // Gone from the owner's list too.
  await owner.goto(`${orgPath}/members`);
  await expect(owner.locator(`tr[data-email="${grace.email}"]`)).toHaveCount(0);

  // Ada, the only owner, is refused and stays.
  await owner.getByTestId("leave").getByRole("button", { name: "Leave organization" }).click();
  await expect(owner.getByTestId("leave").getByRole("alert")).toHaveText("An organization needs at least one owner. Make someone else an owner first.");
  expect((await owner.goto(orgPath))?.status()).toBe(200);

  await Promise.all([ownerContext.close(), memberContext.close()]);
});
