// REVIEW FINDING (minor): parseHash's bounds (N up to 2^20, r up to 32) admit parameters that need more
// memory than verifyPassword's maxmem (128 MiB, since scrypt needs ~128 * N * r bytes), so for those hashes
// verifyPassword throws "memory limit exceeded" instead of returning false. Anything 128 * N * r >= 128 MiB
// throws, including N = 2^17 with today's r = 8, i.e. the very next "raise N later" step DESIGN.md plans for.
// verifyCredentials then rejects (Auth.js reports a server error rather than CredentialsSignin) and, because
// the throw is instant, the known-email path is now faster than the unknown-email path.
//
// Suggested fix: bound parseHash by memory (reject when 128 * N * r > MAX_MEMORY, minus headroom) so every
// hash it accepts can be verified, and/or catch the scrypt error in verifyPassword and return false.
import { describe, expect, it } from "vitest";
import { MAX_HASH_MEMORY, parseHash, verifyPassword } from "@/server/auth/password";

const salt = "A".repeat(22);
const key = "B".repeat(43);

describe("verifyPassword on hashes parseHash accepts", () => {
  it.each([
    [2 ** 17, 8],
    [2 ** 20, 8],
    [2 ** 15, 32],
  ])("returns false (doesn't throw) for N=%i r=%i", async (N, r) => {
    const stored = ["scrypt", N, r, 1, salt, key].join("$");
    // Observed before the fix: rejects with "Invalid scrypt params: ... memory limit exceeded". Fixed by
    // bounding parseHash by memory (128 * N * r <= MAX_HASH_MEMORY), as suggested: each case is now either
    // refused by parseHash or verifiable; neither may throw.
    await expect(verifyPassword("anything at all", stored)).resolves.toBe(false);
    expect(parseHash(stored) === null).toBe(128 * N * r > MAX_HASH_MEMORY);
  });

  it("verifies the right password for the most expensive hash parseHash accepts", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const N = 2 ** 17;
    const r = 8;
    expect(128 * N * r).toBe(MAX_HASH_MEMORY);
    const s = randomBytes(16);
    const k = scryptSync("expensive", s, 32, { N, r, p: 1, maxmem: 2 * MAX_HASH_MEMORY });
    const stored = ["scrypt", N, r, 1, s.toString("base64url"), k.toString("base64url")].join("$");
    expect(await verifyPassword("expensive", stored)).toBe(true);
  });
});
