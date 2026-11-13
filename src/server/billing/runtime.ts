import { db } from "@/server/db/client";
import { runForStripeEvent } from "@/server/dal";
import { readBillingConfig, type BillingConfig } from "./config";
import { MockProvider } from "./mock-provider";
import type { BillingProvider } from "./provider";
import { StripeProvider } from "./stripe-provider";
import { handleStripeWebhook, type WebhookDeps } from "./webhook";

// The configured provider and the webhook's dependencies, made once per process (cached on globalThis, like the
// database client: Next.js may load this module more than once, and the mock's sessions must be shared by the
// mock checkout page, the Server Actions and the webhook route).

interface Billing {
  config: BillingConfig;
  provider: BillingProvider;
  webhook: WebhookDeps;
}

const cache = globalThis as unknown as { tallyBilling?: Billing };

export function billing(): Billing {
  if (!cache.tallyBilling) {
    const config = readBillingConfig();
    const webhook: WebhookDeps = {
      secret: config.webhookSecret,
      run: runForStripeEvent,
      organizationExists: async (id) => (await db().organization.count({ where: { id } })) === 1,
    };
    const provider: BillingProvider =
      config.provider === "stripe"
        ? new StripeProvider({ secretKey: config.stripeSecretKey! })
        : // The mock delivers its signed events straight to the webhook handler, in this process: the same
          // verification and processing as an HTTP delivery from Stripe, without the network.
          new MockProvider({ webhookSecret: config.webhookSecret, deliver: (d) => handleStripeWebhook(d.body, d.header, webhook) });
    cache.tallyBilling = { config, provider, webhook };
  }
  return cache.tallyBilling;
}

/** The mock provider, or null when billing runs against Stripe (the mock checkout page is then a 404). */
export function mockProvider(): MockProvider | null {
  const { provider } = billing();
  return provider instanceof MockProvider ? provider : null;
}
