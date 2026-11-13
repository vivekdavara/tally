import { randomBytes } from "node:crypto";

// Billing configuration from the environment (DESIGN.md, "Environments and configuration"). The mock provider is
// the default, so development, tests and CI never need a Stripe key; Stripe's test mode is opt-in.

export interface BillingConfig {
  provider: "mock" | "stripe";
  /** The webhook signing secret (whsec_...). */
  webhookSecret: string;
  /** Where the customer returns after checkout; Stripe needs absolute URLs. */
  appBaseUrl: string;
  /** Stripe mode only. */
  stripeSecretKey?: string;
}

const cache = globalThis as unknown as { tallyMockWebhookSecret?: string };

/**
 * Reads and checks the billing settings; throws with every problem at once. In mock mode with no
 * STRIPE_WEBHOOK_SECRET, a random secret is made once per process: the mock signs with it and the webhook route
 * verifies with it, both in this process.
 */
export function readBillingConfig(env: Record<string, string | undefined> = process.env): BillingConfig {
  const provider = env.BILLING_PROVIDER ?? "mock";
  const appBaseUrl = (env.APP_BASE_URL ?? "http://localhost:8117").replace(/\/+$/, "");
  const problems: string[] = [];
  if (provider !== "mock" && provider !== "stripe") problems.push(`BILLING_PROVIDER must be mock or stripe, not ${JSON.stringify(provider)}`);
  if (!/^https?:\/\/[^/\s]+$/.test(appBaseUrl)) problems.push("APP_BASE_URL must be an origin like https://tally.example");
  if (provider === "stripe") {
    const key = env.STRIPE_SECRET_KEY ?? "";
    if (!/^(sk|rk)_test_/.test(key)) problems.push("STRIPE_SECRET_KEY must be a test-mode key (sk_test_... or rk_test_...)");
    if (!/^whsec_[A-Za-z0-9_]{8,}$/.test(env.STRIPE_WEBHOOK_SECRET ?? "")) problems.push("STRIPE_WEBHOOK_SECRET must be the endpoint's signing secret (whsec_...)");
    if (problems.length > 0) throw new Error(`billing configuration: ${problems.join("; ")}`);
    return { provider, webhookSecret: env.STRIPE_WEBHOOK_SECRET!, appBaseUrl, stripeSecretKey: key };
  }
  if (problems.length > 0) throw new Error(`billing configuration: ${problems.join("; ")}`);
  cache.tallyMockWebhookSecret ??= `whsec_mock_${randomBytes(24).toString("hex")}`;
  return { provider: "mock", webhookSecret: env.STRIPE_WEBHOOK_SECRET || cache.tallyMockWebhookSecret, appBaseUrl };
}
