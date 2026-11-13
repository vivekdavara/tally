// Webhook signature verification (src/server/billing/signature.ts) against Stripe's scheme: HMAC-SHA256 of
// `${t}.${body}` keyed with the whole signing secret. The scheme is checked against an independent
// implementation (openssl), so a mistake shared by the signer and the verifier here can't hide.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  computeSignature,
  parseSignatureHeader,
  SignatureError,
  signatureHeader,
  verifySignature,
} from "@/server/billing/signature";

const SECRET = "whsec_test_0123456789abcdefghijklmnopqrstuvwxyz";
const NOW = 1_763_049_600; // 2025-11-13T16:00:00Z, any fixed second
const body = Buffer.from(JSON.stringify({ id: "evt_test_1", object: "event", type: "checkout.session.completed" }));

const verify = (payload: Uint8Array, header: string | null, options: { now?: number; secret?: string; toleranceSeconds?: number } = {}) =>
  verifySignature(payload, header, options.secret ?? SECRET, { now: options.now ?? NOW, toleranceSeconds: options.toleranceSeconds });

describe("computeSignature", () => {
  it("is the hex HMAC-SHA256 of `t.body` keyed with the whole secret (checked with openssl)", () => {
    const fromOpenssl = execFileSync("openssl", ["dgst", "-sha256", "-hmac", SECRET, "-r"], { input: Buffer.concat([Buffer.from(`${NOW}.`), body]) })
      .toString()
      .split(" ")[0];
    expect(computeSignature(SECRET, NOW, body)).toBe(fromOpenssl);
  });

  it("covers every byte, including non-ASCII ones", () => {
    const utf8 = Buffer.from('{"name":"Café Ünïcode ₹"}');
    const fromOpenssl = execFileSync("openssl", ["dgst", "-sha256", "-hmac", SECRET, "-r"], { input: Buffer.concat([Buffer.from(`${NOW}.`), utf8]) })
      .toString()
      .split(" ")[0];
    expect(computeSignature(SECRET, NOW, utf8)).toBe(fromOpenssl);
  });
});

describe("verifySignature", () => {
  it("accepts a header Stripe would send and returns its timestamp", () => {
    expect(verify(body, signatureHeader(SECRET, NOW, body))).toBe(NOW);
  });

  it("accepts entries in any order, with v0 and unsigned debug entries around them", () => {
    const sig = computeSignature(SECRET, NOW, body);
    const header = `v0=${"0".repeat(64)},secret=whsec_****PzVt,v1=${sig},t=${NOW},destination=we_1,payload=a25aefc6`;
    expect(verify(body, header)).toBe(NOW);
  });

  it("accepts any matching v1 when several are present (a secret being rolled)", () => {
    const other = computeSignature("whsec_other", NOW, body);
    expect(verify(body, `t=${NOW},v1=${other},v1=${computeSignature(SECRET, NOW, body)}`)).toBe(NOW);
    expect(verify(body, `t=${NOW},v1=${computeSignature(SECRET, NOW, body)},v1=${other}`)).toBe(NOW);
  });

  it("refuses a changed body, a different secret, or a changed timestamp", () => {
    const header = signatureHeader(SECRET, NOW, body);
    const changed = Buffer.from(body.toString().replace("completed", "expired"));
    expect(() => verify(changed, header)).toThrow(/no signature matches/);
    expect(() => verify(body, header, { secret: "whsec_wrong" })).toThrow(/no signature matches/);
    expect(() => verify(body, header.replace(`t=${NOW}`, `t=${NOW + 1}`), { now: NOW + 1 })).toThrow(/no signature matches/);
  });

  it("refuses a body that differs only in whitespace or key order (the raw bytes are what's signed)", () => {
    const header = signatureHeader(SECRET, NOW, body);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(() => verify(reformatted, header)).toThrow(/no signature matches/);
  });

  it("refuses a v0 signature alone, even a correct one", () => {
    const sig = computeSignature(SECRET, NOW, body);
    expect(() => verify(body, `t=${NOW},v0=${sig}`)).toThrow(/no v1 signature/);
  });

  it("accepts up to the tolerance either way and refuses beyond it", () => {
    const header = signatureHeader(SECRET, NOW, body);
    expect(verify(body, header, { now: NOW + 300 })).toBe(NOW);
    expect(verify(body, header, { now: NOW - 300 })).toBe(NOW);
    expect(() => verify(body, header, { now: NOW + 301 })).toThrow(/outside the tolerance/);
    expect(() => verify(body, header, { now: NOW - 301 })).toThrow(/outside the tolerance/);
    expect(verify(body, header, { now: NOW + 3_600, toleranceSeconds: 3_600 })).toBe(NOW);
  });

  it("checks the signature before the timestamp (an old forged request says only 'no match')", () => {
    expect(() => verify(body, `t=${NOW - 10_000},v1=${"a".repeat(64)}`)).toThrow(/no signature matches/);
  });

  it.each([
    [null, /missing/],
    ["", /missing/],
    ["v1=" + "a".repeat(64), /no timestamp/],
    [`t=${NOW}`, /no v1 signature/],
    [`t=${NOW},v1=xyz`, /no v1 signature/],
    [`t=${NOW},v1=${"A".repeat(64)}`, /no v1 signature/],
    [`t=-5,v1=${"a".repeat(64)}`, /not a number/],
    [`t=1e9,v1=${"a".repeat(64)}`, /not a number/],
    [`t=${NOW},t=${NOW},v1=${"a".repeat(64)}`, /two timestamps/],
    [`t=${NOW},v1=${"a".repeat(64)},${"x".repeat(5000)}`, /too long/],
  ])("refuses the header %j", (header, error) => {
    expect(() => verify(body, header as string | null)).toThrow(error);
    expect(() => verify(body, header as string | null)).toThrow(SignatureError);
  });

  it("refuses everything when no secret is configured", () => {
    expect(() => verify(body, signatureHeader("", NOW, body), { secret: "" })).toThrow(/no webhook signing secret/);
  });
});

describe("parseSignatureHeader", () => {
  it("collects every well-formed v1 and the timestamp", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    expect(parseSignatureHeader(` t = ${NOW} , v1=${a},v1=${b},v1=short`)).toEqual({ timestamp: NOW, signatures: [a, b] });
  });
});
