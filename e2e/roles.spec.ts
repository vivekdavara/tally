import { expect, test } from "@playwright/test";
import { draftInvoice, finalize, person, signUp } from "./helpers";

// Day 4 in two browsers: an owner invites someone by link, they join as a member and can't finalize; the owner makes
// them an admin and they can. The link works only for the invited address, and once. The last owner can't step down.

test("an invited member can't finalize until an owner makes them an admin", async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  const strangerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const invitee = await inviteeContext.newPage();
  const stranger = await strangerContext.newPage();
  const ada = person("ada");
  const charles = person("charles");

  const orgPath = await signUp(owner, ada);
  const invoicePath = await draftInvoice(owner, orgPath, `customer-${Date.now()}@example.com`);

  // The owner creates an invitation link for Charles as a member.
  await owner.goto(`${orgPath}/members`);
  const invite = owner.getByTestId("invite");
  await invite.getByLabel("Email").fill(charles.email);
  await invite.getByLabel("Role").selectOption("MEMBER");
  await invite.getByRole("button", { name: "Create invitation link" }).click();
  const link = (await owner.getByTestId("invite-notice").textContent())!;
  expect(link).toMatch(/^http:\/\/localhost:8117\/invite\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  await expect(owner.getByTestId("invitations").getByRole("cell", { name: charles.email })).toBeVisible();

  // Someone else signed in with the link: no way in.
  await signUp(stranger, person("eve"));
  await stranger.goto(new URL(link).pathname);
  await expect(stranger.getByTestId("wrong-email")).toBeVisible();
  await expect(stranger.getByTestId("accept-invitation")).toHaveCount(0);

  // Charles signs up with the invited address and accepts.
  await signUp(invitee, charles);
  await invitee.goto(new URL(link).pathname);
  await invitee.getByRole("button", { name: "Accept invitation" }).click();
  await expect(invitee).toHaveURL(new RegExp(`${orgPath}$`));
  await expect(invitee.getByText(/member\.$/)).toBeVisible();
  // The link is used up.
  expect((await invitee.goto(new URL(link).pathname))?.status()).toBe(404);

  // As a member: the draft can be edited but not finalized; the form isn't there.
  await invitee.goto(invoicePath);
  await expect(invitee.getByTestId("finalize-needs-role")).toBeVisible();
  await expect(invitee.getByTestId("finalize")).toHaveCount(0);
  await expect(invitee.getByTestId("add-line")).toBeVisible();

  // The owner makes Charles an admin.
  await owner.goto(`${orgPath}/members`);
  const roleForm = owner.getByTestId(`role-${charles.email}`);
  await roleForm.getByLabel("Role").selectOption("ADMIN");
  await roleForm.getByRole("button", { name: "Change" }).click();
  await expect(owner.locator(`tr[data-email="${charles.email}"]`)).toHaveAttribute("data-role", "ADMIN");

  // Now Charles can finalize, and an admin still can't touch the owner.
  await invitee.goto(invoicePath);
  await finalize(invitee);
  await invitee.goto(`${orgPath}/members`);
  await expect(invitee.getByTestId(`role-${ada.email}`)).toHaveCount(0);
  await expect(invitee.getByTestId(`remove-${ada.email}`)).toHaveCount(0);

  // The only owner can't step down.
  await owner.goto(`${orgPath}/members`);
  const own = owner.getByTestId(`role-${ada.email}`);
  await own.getByLabel("Role").selectOption("ADMIN");
  await own.getByRole("button", { name: "Change" }).click();
  await expect(own.getByRole("alert")).toHaveText("An organization needs at least one owner. Make someone else an owner first.");
  await expect(owner.locator(`tr[data-email="${ada.email}"]`)).toHaveAttribute("data-role", "OWNER");

  await Promise.all([ownerContext.close(), inviteeContext.close(), strangerContext.close()]);
});
