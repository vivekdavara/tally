import { describe, expect, it } from "vitest";
import { signInInput, signUpInput } from "@/server/auth/schemas";

const good = { name: "Ada Lovelace", email: "ada@example.com", password: "analytical engine", organizationName: "Acme" };

describe("signUpInput", () => {
  it("normalizes the email to its stored form and trims names", () => {
    const parsed = signUpInput.parse({ ...good, email: "  Ada@Example.COM ", name: "  Ada  " });
    expect(parsed).toMatchObject({ email: "ada@example.com", name: "Ada" });
  });

  it("keeps the password exactly as typed (no trimming)", () => {
    expect(signUpInput.parse({ ...good, password: "  spaces count  " }).password).toBe("  spaces count  ");
  });

  it.each([
    ["a short password", { password: "123456789" }, "password"],
    ["a long password", { password: "x".repeat(129) }, "password"],
    ["a malformed email", { email: "not-an-email" }, "email"],
    ["a blank name", { name: "   " }, "name"],
    ["a blank organization", { organizationName: "" }, "organizationName"],
    ["a long organization name", { organizationName: "x".repeat(101) }, "organizationName"],
  ])("refuses %s", (_, change, field) => {
    const result = signUpInput.safeParse({ ...good, ...change });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toEqual([field]);
  });

  it("accepts the boundary lengths", () => {
    expect(signUpInput.safeParse({ ...good, password: "x".repeat(10) }).success).toBe(true);
    expect(signUpInput.safeParse({ ...good, password: "x".repeat(128) }).success).toBe(true);
  });
});

describe("signInInput", () => {
  it("normalizes the email the same way sign-up does", () => {
    expect(signInInput.parse({ email: " ADA@example.com", password: "p" }).email).toBe("ada@example.com");
  });

  it("caps the password length and nothing else, so old passwords keep working if the rules change", () => {
    expect(signInInput.safeParse({ email: "a@example.com", password: "short" }).success).toBe(true);
    expect(signInInput.safeParse({ email: "a@example.com", password: "x".repeat(129) }).success).toBe(false);
  });

  it("refuses non-string input from a crafted request", () => {
    expect(signInInput.safeParse({ email: ["a@example.com"], password: "p" }).success).toBe(false);
    expect(signInInput.safeParse({ email: "a@example.com", password: { length: 3 } }).success).toBe(false);
    expect(signInInput.safeParse(undefined).success).toBe(false);
  });
});
