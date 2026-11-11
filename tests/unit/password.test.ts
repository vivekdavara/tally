import { describe, expect, it } from "vitest";
import { dummyHash, hashPassword, parseHash, SCRYPT, verifyPassword } from "@/server/auth/password";

describe("hashPassword and verifyPassword", () => {
  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("stores the algorithm, parameters, salt and key", async () => {
    const stored = await hashPassword("correct horse battery");
    const [scheme, n, r, p, salt, key] = stored.split("$");
    expect([scheme, Number(n), Number(r), Number(p)]).toEqual(["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(SCRYPT.saltLength);
    expect(Buffer.from(key!, "base64url")).toHaveLength(SCRYPT.keyLength);
  });

  it("salts: the same password hashes differently each time, and both verify", async () => {
    const [h1, h2] = await Promise.all([hashPassword("same password!"), hashPassword("same password!")]);
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("same password!", h1)).toBe(true);
    expect(await verifyPassword("same password!", h2)).toBe(true);
  });

  it("treats composed and decomposed accents as the same password (NFKC)", async () => {
    const composed = "café au lait!";
    const decomposed = "café au lait!";
    expect(composed).not.toBe(decomposed);
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true);
  });

  it("verifies a hash made with other parameters, read from the hash itself", async () => {
    // As if SCRYPT.N were raised later: old hashes must still verify.
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync("older password", salt, 32, { N: 2 ** 14, r: 8, p: 2 });
    const stored = ["scrypt", 2 ** 14, 8, 2, salt.toString("base64url"), key.toString("base64url")].join("$");
    expect(await verifyPassword("older password", stored)).toBe(true);
    expect(await verifyPassword("other password", stored)).toBe(false);
  });

  it("refuses when one bit of the stored key or salt is changed", async () => {
    const stored = await hashPassword("correct horse battery");
    for (const field of [4, 5]) {
      const parts = stored.split("$");
      const bytes = Buffer.from(parts[field]!, "base64url");
      bytes[0]! ^= 1;
      parts[field] = bytes.toString("base64url");
      expect(await verifyPassword("correct horse battery", parts.join("$"))).toBe(false);
    }
  });
});

describe("parseHash", () => {
  const valid = ["scrypt", 2 ** 15, 8, 1, "A".repeat(22), "B".repeat(43)].join("$");

  it("accepts a well-formed hash", () => {
    expect(parseHash(valid)).toMatchObject({ N: 2 ** 15, r: 8, p: 1 });
  });

  it.each([
    ["another scheme", valid.replace("scrypt", "bcrypt")],
    ["too few fields", valid.split("$").slice(0, 5).join("$")],
    ["too many fields", `${valid}$x`],
    ["N not a power of two", valid.replace("$32768$", "$32767$")],
    ["N below 2^14 (too cheap to be ours)", valid.replace("$32768$", "$8192$")],
    ["N above 2^20 (a gigabyte of memory)", valid.replace("$32768$", "$2097152$")],
    ["r above 32", valid.replace("$8$", "$64$")],
    ["p above 16", valid.replace("$8$1$", "$8$17$")],
    ["a zero", valid.replace("$8$1$", "$8$0$")],
    ["a leading zero", valid.replace("$8$1$", "$08$1$")],
    ["a sign", valid.replace("$8$1$", "$+8$1$")],
    ["a short salt", valid.replace("A".repeat(22), "A".repeat(10))],
    ["a short key", valid.replace("B".repeat(43), "B".repeat(10))],
    ["a long key", valid.replace("B".repeat(43), "B".repeat(100))],
    ["non-base64url characters", valid.replace("A".repeat(22), `${"A".repeat(21)}+`)],
    ["empty", ""],
  ])("refuses %s", async (_, stored) => {
    expect(parseHash(stored)).toBeNull();
    expect(await verifyPassword("anything at all", stored)).toBe(false);
  });
});

describe("dummyHash", () => {
  it("is one well-formed hash per process that no ordinary password verifies against", async () => {
    const [a, b] = await Promise.all([dummyHash(), dummyHash()]);
    expect(a).toBe(b);
    expect(parseHash(a)).not.toBeNull();
    expect(await verifyPassword("password123", a)).toBe(false);
  });
});
