// REVIEW FINDING (minor): signUpInput accepts a NUL character in the name or the organization name, which
// Postgres text can't store, so signUpAction throws (Prisma P2039, Postgres 22021 "invalid byte sequence for
// encoding UTF8: 0x00") and the visitor gets a 500 instead of a field error. DESIGN.md: "Zod validates every
// form and action input at the boundary." A crafted multipart request can carry the byte.
//
// Suggested fix: refuse control characters in the shared name schema, e.g.
// .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "Use printable characters only.").
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { unique } from "../helpers";

vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("@/auth", () => ({
  auth: async () => null,
  signIn: async () => undefined,
  signOut: async () => undefined,
  handlers: {},
}));

afterAll(async () => {
  await db().$disconnect();
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

describe("signUpAction with a NUL byte", () => {
  it.each([["name"], ["organizationName"]])("answers with a field error for %s, not a server error", async (field) => {
    const { signUpAction } = await import("@/app/actions");
    const fields = {
      name: "Ada",
      email: `nul-${unique()}@example.com`,
      password: "analytical engine",
      organizationName: "Acme",
      [field]: "Acme\u0000Inc",
    };
    // Observed: rejects with PrismaClientKnownRequestError (P2039, 22021).
    const state = await signUpAction({}, form(fields));
    expect(state.fieldErrors?.[field]).toBeDefined();
  });
});
