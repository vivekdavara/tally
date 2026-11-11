// Layer 1 (DESIGN.md): what requireUser and requireMembership do for each kind of session. The session is
// mocked (Auth.js needs a request); the users and memberships are real rows read through db().
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { signUpInput } from "@/server/auth/schemas";
import { signUp } from "@/server/auth/signup";
import { db } from "@/server/db/client";
import { unique } from "../helpers";

const session = vi.hoisted(() => ({ current: null as null | { user?: { id?: string } } }));
vi.mock("@/auth", () => ({ auth: async () => session.current }));

const { requireMembership, requireUser } = await import("@/server/dal");

/** The digest Next.js puts on the error that redirect() and notFound() throw. */
async function digestOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => {
      throw new Error("expected a redirect or a 404");
    },
    (e: unknown) => e,
  );
  return String((error as { digest?: unknown }).digest);
}

let owner: { userId: string; slug: string; organizationId: string };
let outsider: { userId: string; slug: string };

async function newAccount() {
  const u = unique();
  const result = await signUp(
    signUpInput.parse({ name: `User ${u}`, email: `dal-${u}@example.com`, password: "long enough!", organizationName: `Dal ${u}` }),
  );
  if (!result.ok) throw new Error("sign-up failed");
  return result;
}

beforeAll(async () => {
  owner = await newAccount();
  outsider = await newAccount();
});

beforeEach(() => {
  session.current = null;
});

afterAll(async () => {
  await db().$disconnect();
});

describe("requireUser", () => {
  it("redirects to /signin without a session, or with one that has no user id", async () => {
    expect(await digestOf(requireUser())).toMatch(/^NEXT_REDIRECT;replace;\/signin;307;/);
    session.current = { user: {} };
    expect(await digestOf(requireUser())).toMatch(/^NEXT_REDIRECT;replace;\/signin;/);
  });

  it("returns the user read from the database, not from the token", async () => {
    session.current = { user: { id: owner.userId } };
    expect(await requireUser()).toMatchObject({ id: owner.userId, email: expect.stringMatching(/^dal-.*@example\.com$/) });
  });

  it("redirects a session whose user has been deleted", async () => {
    const gone = await newAccount();
    await db().user.delete({ where: { id: gone.userId } });
    session.current = { user: { id: gone.userId } };
    expect(await digestOf(requireUser())).toMatch(/^NEXT_REDIRECT;replace;\/signin;/);
  });
});

describe("requireMembership", () => {
  it("returns the organization and role for a member", async () => {
    session.current = { user: { id: owner.userId } };
    expect(await requireMembership(owner.slug)).toMatchObject({
      role: "OWNER",
      organization: { id: owner.organizationId, slug: owner.slug },
      user: { id: owner.userId },
    });
  });

  it("is the same 404 for another organization and for one that doesn't exist", async () => {
    session.current = { user: { id: outsider.userId } };
    const foreign = await digestOf(requireMembership(owner.slug));
    const missing = await digestOf(requireMembership(`missing-${unique()}`));
    expect(foreign).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(missing).toBe(foreign);
  });

  it("stops working as soon as the membership is removed", async () => {
    const member = await newAccount();
    await db().membership.create({ data: { userId: member.userId, organizationId: owner.organizationId, role: "MEMBER" } });
    session.current = { user: { id: member.userId } };
    expect((await requireMembership(owner.slug)).role).toBe("MEMBER");
    await db().membership.delete({
      where: { organizationId_userId: { organizationId: owner.organizationId, userId: member.userId } },
    });
    expect(await digestOf(requireMembership(owner.slug))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("sends a signed-out visitor to sign in before looking at the slug", async () => {
    expect(await digestOf(requireMembership(owner.slug))).toMatch(/^NEXT_REDIRECT;replace;\/signin;/);
  });
});
