// REVIEW FINDING: a deleted user's still-valid session cookie traps the browser in a redirect loop.
//
// requireUser() (src/server/dal.ts) looks the user up and, when the row is gone, redirects to /signin. But
// /signin (and /signup) only ask whether the JWT carries an id, not whether that user exists, and redirect
// a "signed-in" visitor to /o, whose requireUser() redirects back to /signin: /signin -> /o -> /signin ...
// until the browser gives up (ERR_TOO_MANY_REDIRECTS). The visitor can't reach the sign-in form to sign in
// as someone else until the 7-day cookie expires or they clear cookies by hand. The same happens to any
// session whose user lookup fails.
//
// Suggested fix: have the sign-in and sign-up pages redirect only when the user exists (call a non-redirecting
// variant of requireUser, e.g. currentUser(): CurrentUser | null), or have requireUser sign the stale session
// out (clear the cookie) before redirecting.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { appDb, ownerDb, unique } from "../helpers";

const session = vi.hoisted(() => ({ userId: undefined as string | undefined }));

vi.mock("@/auth", () => ({
  auth: async () => (session.userId ? { user: { id: session.userId }, expires: "2099-01-01T00:00:00.000Z" } : null),
  signIn: async () => undefined,
  signOut: async () => undefined,
  handlers: {},
}));
// The form is a client component that imports the Server Actions (and next-auth); not needed here.
vi.mock("@/app/signin/signin-form", () => ({ SignInForm: () => null }));

/** Where a server component or helper redirects to, or "rendered" if it doesn't. */
async function destination(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "rendered";
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2]!;
    throw error;
  }
}

let app: Db;

beforeAll(() => {
  app = appDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
});

describe("a session whose user was deleted", () => {
  it("can still reach the sign-in form", async () => {
    const user = await app.user.create({ data: { email: `gone-${unique()}@example.com`, name: "Gone", passwordHash: "x" } });
    // (Adapted: since least_privilege only an administrator, the owner role, can delete users.)
    const admin = ownerDb({ max: 1 });
    await admin.user.delete({ where: { id: user.id } }).finally(() => admin.$disconnect());
    session.userId = user.id;

    const { requireUser } = await import("@/server/dal");
    const { default: SignInPage } = await import("@/app/signin/page");

    // /o calls requireUser(): the user is gone, so it sends the visitor to /signin...
    expect(await destination(() => requireUser())).toBe("/signin");
    // ...and /signin should then show the form. Observed: "/o", which redirects to /signin again, forever.
    expect(await destination(() => SignInPage())).toBe("rendered");
  });
});
