import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe's webhook signatures (DESIGN.md, "Billing"). Stripe sends a `Stripe-Signature` header like
//
//   t=1763049600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=...
//
// where v1 is the hex HMAC-SHA256, keyed with the endpoint's signing secret (the whole `whsec_...` string), of
// `${t}.${raw request body}`. While a secret is being rolled, Stripe signs with every active secret, so several
// v1 entries can appear; v0 appears only on test events and isn't a signature we accept; the header may carry
// unsigned debug entries (secret=..., payload=...) and its entries come in no fixed order. A request is
// authentic if any v1 entry matches the HMAC computed here, and fresh if `t` is within the tolerance of now.

/** Stripe's libraries default to five minutes. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Longer headers are refused before parsing (a real one is about 150 characters per secret). */
const MAX_HEADER_LENGTH = 4096;

export class SignatureError extends Error {}

export interface ParsedHeader {
  timestamp: number;
  /** The v1 entries that are well-formed (64 hex digits); malformed ones could never match and are dropped. */
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedHeader {
  if (header.length > MAX_HEADER_LENGTH) throw new SignatureError("signature header too long");
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const item of header.split(",")) {
    const at = item.indexOf("=");
    if (at < 0) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (key === "t") {
      // Two timestamps make it ambiguous which one was signed; Stripe never sends two.
      if (timestamp !== undefined) throw new SignatureError("signature header has two timestamps");
      if (!/^\d{1,12}$/.test(value)) throw new SignatureError("signature header timestamp is not a number");
      timestamp = Number(value);
    } else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === undefined) throw new SignatureError("signature header has no timestamp");
  if (signatures.length === 0) throw new SignatureError("signature header has no v1 signature");
  return { timestamp, signatures };
}

/** The v1 signature of `payload` sent at `timestamp` (seconds), as Stripe computes it. */
export function computeSignature(secret: string, timestamp: number, payload: Uint8Array): string {
  return createHmac("sha256", secret).update(`${timestamp}.`, "utf8").update(payload).digest("hex");
}

/** A header the way Stripe builds one: for the mock provider and for tests. */
export function signatureHeader(secret: string, timestamp: number, payload: Uint8Array): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, payload)}`;
}

export interface VerifyOptions {
  /** Now, in Unix seconds (tests pass a fixed clock). */
  now?: number;
  toleranceSeconds?: number;
}

/**
 * Checks that `payload` (the raw body bytes, exactly as received) was signed by Stripe with `secret` within the
 * tolerance, and returns the signed timestamp. Throws SignatureError otherwise. The signature is checked before
 * the timestamp, and with a constant-time comparison per candidate, so a forger learns nothing from timing or
 * from which check failed. The tolerance applies both ways: Stripe's libraries accept any future timestamp, but a
 * signed request from more than five minutes in the future only happens with a broken clock, so it is refused.
 */
export function verifySignature(payload: Uint8Array, header: string | null, secret: string, options: VerifyOptions = {}): number {
  if (!secret) throw new SignatureError("no webhook signing secret is configured");
  if (header === null || header === "") throw new SignatureError("missing Stripe-Signature header");
  const { timestamp, signatures } = parseSignatureHeader(header);
  const expected = Buffer.from(computeSignature(secret, timestamp, payload), "hex");
  let matched = false;
  for (const candidate of signatures) {
    // Every candidate is compared (no early exit), each in constant time: 32 bytes against 32 bytes.
    if (timingSafeEqual(Buffer.from(candidate, "hex"), expected)) matched = true;
  }
  if (!matched) throw new SignatureError("no signature matches the payload");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) throw new SignatureError("signature timestamp is outside the tolerance");
  return timestamp;
}
