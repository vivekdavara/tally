import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyCredentials } from "@/server/auth/credentials";
import { dummyHash, verifyPassword } from "@/server/auth/password";
import { signUpInput } from "@/server/auth/schemas";
import { signUp } from "@/server/auth/signup";
import type { Db } from "@/server/db/client";
import { findMembership, listMemberships } from "@/server/orgs/memberships";
import { withTenant } from "@/server/db/tenant";
import { appDb, ownerDb, unique } from "../helpers";

let app: Db;

beforeAll(() => {
  app = appDb({ max: 10 });
});

afterAll(async () => {
  await app.$disconnect();
});

function input(overrides: Partial<Record<"name" | "email" | "password" | "organizationName", string>> = {}) {
  const u = unique();
  return signUpInput.parse({
    name: "Ada Lovelace",
    email: `ada-${u}@example.com`,
    password: "analytical engine",
    organizationName: `Engines ${u}`,
    ...overrides,
  });
}

describe("signUp", () => {
  it("creates the user, the organization and an OWNER membership", async () => {
    const data = input({ email: `  Ada-${unique()}@Example.COM ` });
    const result = await signUp(data, app);
    if (!result.ok) throw new Error("sign-up failed");
    const user = await app.user.findUniqueOrThrow({ where: { id: result.userId }, include: { memberships: true } });
    expect(user.email).toBe(data.email);
    expect(user.email).toBe(user.email.toLowerCase().trim());
    expect(await verifyPassword("analytical engine", user.passwordHash)).toBe(true);
    expect(user.memberships).toEqual([
      expect.objectContaining({ organizationId: result.organizationId, role: "OWNER" }),
    ]);
    const org = await app.organization.findUniqueOrThrow({ where: { id: result.organizationId } });
    expect(org).toMatchObject({ name: data.organizationName, slug: result.slug });
    expect(result.slug).toBe(data.organizationName.toLowerCase().replace(" ", "-"));
  });

  it("refuses a taken email, whatever its case, and creates nothing", async () => {
    const first = input();
    expect((await signUp(first, app)).ok).toBe(true);
    const again = input({ email: first.email.toUpperCase() });
    expect(again.email).toBe(first.email);
    expect(await signUp(again, app)).toEqual({ ok: false, reason: "email_taken" });
    expect(await app.organization.count({ where: { name: again.organizationName } })).toBe(0);
  });

  it("gives a second organization with the same name a suffixed slug", async () => {
    const name = `Same Name ${unique()}`;
    const one = await signUp(input({ organizationName: name }), app);
    const two = await signUp(input({ organizationName: name }), app);
    if (!one.ok || !two.ok) throw new Error("sign-up failed");
    const base = name.toLowerCase().replaceAll(" ", "-");
    expect(one.slug).toBe(base);
    expect(two.slug).toMatch(new RegExp(`^${base}-[a-z0-9]{6}$`));
  });

  it("lets concurrent sign-ups with the same organization name all succeed, each with its own slug", async () => {
    const name = `Rush ${unique()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () => signUp(input({ organizationName: name }), app)));
    const slugs = results.map((r) => (r.ok ? r.slug : "failed"));
    expect(slugs).not.toContain("failed");
    expect(new Set(slugs).size).toBe(8);
  });

  it("lets exactly one of several concurrent sign-ups with the same email succeed, and leaves no partial rows", async () => {
    const email = `race-${unique()}@example.com`;
    const names = Array.from({ length: 6 }, (_, i) => `Race ${i} ${unique()}`);
    const results = await Promise.all(names.map((organizationName) => signUp(input({ email, organizationName }), app)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(Array(5).fill({ ok: false, reason: "email_taken" }));
    expect(await app.user.count({ where: { email } })).toBe(1);
    expect(await app.organization.count({ where: { name: { in: names } } })).toBe(1);
  });
});

describe("signUp on an unexpected database error", () => {
  it("rethrows it at once instead of retrying it as a slug collision", async () => {
    let calls = 0;
    const failing = {
      $transaction: async () => {
        calls++;
        throw new Error("connection reset");
      },
    } as unknown as Parameters<typeof signUp>[1];
    await expect(signUp(input(), failing)).rejects.toThrow("connection reset");
    expect(calls).toBe(1);
  });
});

describe("verifyCredentials", () => {
  let email: string;
  let userId: string;

  beforeAll(async () => {
    const data = input();
    const result = await signUp(data, app);
    if (!result.ok) throw new Error("sign-up failed");
    email = data.email;
    userId = result.userId;
    // Made once per process: build it now, so the timing test below measures the verification itself
    // (round 1: replacing the verification with a bare `await dummyHash()` survived, because the first
    // call built the hash with one scrypt).
    await dummyHash();
  });

  it("returns the user for the right password, with the email in any case", async () => {
    expect(await verifyCredentials({ email, password: "analytical engine" }, app)).toEqual({
      id: userId,
      email,
      name: "Ada Lovelace",
    });
    expect(await verifyCredentials({ email: ` ${email.toUpperCase()} `, password: "analytical engine" }, app)).toMatchObject({
      id: userId,
    });
  });

  it("returns null for a wrong password and for an unknown email, each after one scrypt", async () => {
    // A lower bound only (one scrypt takes ~45 ms here): the unknown-email path must not skip the hash.
    for (const attempt of [
      { email, password: "analytical engin" },
      { email: `nobody-${unique()}@example.com`, password: "analytical engine" },
    ]) {
      const start = performance.now();
      expect(await verifyCredentials(attempt, app)).toBeNull();
      expect(performance.now() - start).toBeGreaterThan(20);
    }
  });

  it.each([
    ["no input", undefined],
    ["a non-string password", { email: "a@example.com", password: ["x"] }],
    ["a password over the cap", { email: "a@example.com", password: "x".repeat(129) }],
    ["a malformed email", { email: "not an email", password: "analytical engine" }],
  ])("returns null for %s", async (_, raw) => {
    expect(await verifyCredentials(raw, app)).toBeNull();
  });

  it("stops working for a deleted user", async () => {
    const data = input();
    const result = await signUp(data, app);
    if (!result.ok) throw new Error("sign-up failed");
    // The app role can't delete users; an administrator (the owner role) can.
    const owner = ownerDb({ max: 1 });
    await owner.user.delete({ where: { id: result.userId } }).finally(() => owner.$disconnect());
    expect(await verifyCredentials({ email: data.email, password: data.password }, app)).toBeNull();
  });
});

describe("memberships", () => {
  it("finds a member's role, and answers null alike for a non-member and a slug that doesn't exist", async () => {
    const owner = await signUp(input(), app);
    const outsider = await signUp(input(), app);
    if (!owner.ok || !outsider.ok) throw new Error("sign-up failed");
    expect(await findMembership(app, owner.userId, owner.slug)).toMatchObject({
      role: "OWNER",
      organization: { id: owner.organizationId, slug: owner.slug },
    });
    expect(await findMembership(app, outsider.userId, owner.slug)).toBeNull();
    expect(await findMembership(app, owner.userId, `missing-${unique()}`)).toBeNull();
  });

  it("lists a user's organizations by name", async () => {
    const result = await signUp(input({ organizationName: `Zeta ${unique()}` }), app);
    if (!result.ok) throw new Error("sign-up failed");
    const second = await app.organization.create({ data: { name: `Alpha ${unique()}`, slug: `alpha-${unique()}` } });
    // Memberships are written only for the transaction's tenant.
    await withTenant(
      second.id,
      (tx) => tx.membership.create({ data: { userId: result.userId, organizationId: second.id, role: "MEMBER" } }),
      app,
    );
    const list = await listMemberships(app, result.userId);
    expect(list.map((m) => [m.organization.name.split(" ")[0], m.role])).toEqual([
      ["Alpha", "MEMBER"],
      ["Zeta", "OWNER"],
    ]);
  });
});
