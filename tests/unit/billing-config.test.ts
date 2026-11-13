// Billing configuration (src/server/billing/config.ts): the mock is the default and needs nothing; Stripe mode needs
// a test-mode key and the endpoint's signing secret, and refuses a live key outright.
import { describe, expect, it } from "vitest";
import { readBillingConfig } from "@/server/billing/config";

// Assembled at run time: no key-shaped literal in the repository (GitHub's push protection refused one on day 3).
const key = (mode: string) => ["sk", mode, "FAKE".repeat(6)].join("_");
const WHSEC = ["whsec", "FAKEFAKEFAKEFAKE"].join("_");

describe("readBillingConfig", () => {
  it("defaults to the mock, with a per-process secret and the local origin", () => {
    const a = readBillingConfig({});
    expect(a).toMatchObject({ provider: "mock", appBaseUrl: "http://localhost:8117" });
    expect(a.webhookSecret).toMatch(/^whsec_mock_[0-9a-f]{48}$/);
    // Once per process: the mock signs and the webhook verifies with the same one.
    expect(readBillingConfig({}).webhookSecret).toBe(a.webhookSecret);
    expect(a.stripeSecretKey).toBeUndefined();
  });

  it("uses a configured signing secret in mock mode (the e2e tests sign with it)", () => {
    expect(readBillingConfig({ STRIPE_WEBHOOK_SECRET: WHSEC }).webhookSecret).toBe(WHSEC);
  });

  it("accepts Stripe test mode with a test key and a signing secret", () => {
    const config = readBillingConfig({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: key("test"), STRIPE_WEBHOOK_SECRET: WHSEC, APP_BASE_URL: "https://tally.example/" });
    expect(config).toEqual({ provider: "stripe", stripeSecretKey: key("test"), webhookSecret: WHSEC, appBaseUrl: "https://tally.example" });
  });

  it("refuses a live key, a missing secret, an unknown provider or a bad origin, naming each problem", () => {
    expect(() => readBillingConfig({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: key("live"), STRIPE_WEBHOOK_SECRET: WHSEC })).toThrow(/test-mode key/);
    expect(() => readBillingConfig({ BILLING_PROVIDER: "stripe", STRIPE_SECRET_KEY: key("test") })).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => readBillingConfig({ BILLING_PROVIDER: "paypal" })).toThrow(/mock or stripe/);
    expect(() => readBillingConfig({ APP_BASE_URL: "tally.example/path" })).toThrow(/APP_BASE_URL/);
    expect(() => readBillingConfig({ BILLING_PROVIDER: "stripe" })).toThrow(/STRIPE_SECRET_KEY.*; STRIPE_WEBHOOK_SECRET/);
  });
});
