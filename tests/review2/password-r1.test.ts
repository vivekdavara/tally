// REVIEW 2 FINDING (minor): e98f346 says every hash parseHash accepts can now be verified, but parseHash still
// accepts r = 1 with N >= 2^16, which RFC 7914 forbids (N < 2^(128 * r / 8)) and Node/OpenSSL refuses with
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS ("memory limit exceeded"). Only verifyPassword's catch keeps this from
// being a 500, and no test exercises that catch (deleting the try/catch leaves the suite green).
//
// Suggested fix: in parseHash, also require N < 2 ** (16 * r) (with LIMITS.maxLogN = 20 that means r >= 2
// whenever N >= 2^16); keep the catch, and test it with one of these hashes.
import { describe, expect, it } from "vitest";
import { parseHash, verifyPassword } from "@/server/auth/password";

const salt = "A".repeat(22);
const key = "B".repeat(43);

describe("parseHash and RFC 7914's N < 2^(16 r)", () => {
  it.each([2 ** 16, 2 ** 17, 2 ** 20])("refuses N=%i with r=1, a hash no scrypt can run", async (N) => {
    const stored = ["scrypt", N, 1, 1, salt, key].join("$");
    await expect(verifyPassword("whatever", stored)).resolves.toBe(false);
    // Observed: parseHash returns the parsed parameters.
    expect(parseHash(stored)).toBeNull();
  });
});
