import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

// DESIGN.md, "Authentication": scrypt from Node's crypto, parameters stored with each hash.
export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

// scrypt needs about 128 * N * r bytes (32 MiB for SCRYPT), plus working space; Node refuses to start one
// whose estimate reaches `maxmem`. Stored hashes may use up to MAX_HASH_MEMORY, and maxmem is twice that, so
// every hash parseHash accepts can actually be verified (review round 1: N = 2^17, r = 8 threw).
export const MAX_HASH_MEMORY = 128 * 1024 * 1024;
const MAX_MEMORY = 2 * MAX_HASH_MEMORY;

// Bounds on parameters read back from a stored hash, so a corrupted or hostile value can't make one
// verification take minutes or gigabytes.
const LIMITS = { minLogN: 14, maxLogN: 20, maxR: 32, maxP: 16, minKey: 16, maxKey: 64, minSalt: 16, maxSalt: 64 };

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** NFKC, so the same password typed on two keyboards (composed or decomposed accents) is the same bytes. */
function normalize(password: string): string {
  return password.normalize("NFKC");
}

/** `scrypt$<N>$<r>$<p>$<salt>$<key>`, salt and key in base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const { N, r, p, keyLength } = SCRYPT;
  const key = await scrypt(normalize(password), salt, keyLength, { N, r, p, maxmem: MAX_MEMORY });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^[1-9][0-9]{0,7}$/;

export function parseHash(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, salt, key] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((v) => DECIMAL.test(v)) || !BASE64URL.test(salt) || !BASE64URL.test(key)) return null;
  const parsed = { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt, "base64url"), key: Buffer.from(key, "base64url") };
  const logN = Math.log2(parsed.N);
  if (!Number.isInteger(logN) || logN < LIMITS.minLogN || logN > LIMITS.maxLogN) return null;
  if (parsed.r > LIMITS.maxR || parsed.p > LIMITS.maxP) return null;
  if (128 * parsed.N * parsed.r > MAX_HASH_MEMORY) return null;
  // RFC 7914 requires N < 2^(16 r); Node refuses anything else (review round 2: r = 1 with N >= 2^16 parsed).
  if (parsed.N >= 2 ** (16 * parsed.r)) return null;
  if (parsed.key.length < LIMITS.minKey || parsed.key.length > LIMITS.maxKey) return null;
  if (parsed.salt.length < LIMITS.minSalt || parsed.salt.length > LIMITS.maxSalt) return null;
  return parsed;
}

/** Constant-time comparison; a malformed stored hash verifies nothing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, key } = parsed;
  try {
    const candidate = await scrypt(normalize(password), salt, key.length, { N, r, p, maxmem: MAX_MEMORY });
    return timingSafeEqual(candidate, key);
  } catch {
    // Parameters Node won't run (parseHash should already have refused them): no match, not a 500.
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * A hash of a random password nobody knows, made once per process. Sign-in verifies against it when the
 * email has no account, so that case costs one scrypt like a wrong password does, and the response time
 * doesn't say which emails are registered.
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(32).toString("base64url"));
  return dummy;
}
