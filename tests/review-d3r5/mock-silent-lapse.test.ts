// Review d3r5: when a mock session runs past expires_at, MockProvider.open() marks it expired but emits nothing, so
// its event log (listEvents) has no checkout.session.expired, which Stripe sends for every session that runs out.
// Reconciliation against the mock can then never record that expiry.
import { describe, expect, it } from "vitest";
import { MockProvider } from "@/server/billing/mock-provider";

describe("MockProvider event log", () => {
  it("logs the expiry of a session that ran out on its own", async () => {
    let clock = 1_763_000_000;
    const mock = new MockProvider({ webhookSecret: "whsec_lapse", now: () => clock });
    const session = await mock.createCheckoutSession({
      amountMinor: 5342n, currency: "USD", description: "Invoice", customerEmail: "p@navy.example",
      successUrl: "http://localhost:8117/s", cancelUrl: "http://localhost:8117/c",
      metadata: { organization_id: "00000000-0000-4000-8000-00000000000a", invoice_id: "00000000-0000-4000-8000-00000000000b" },
      idempotencyKey: "lapse-1",
    });
    clock += 25 * 3600;
    await mock.expireCheckoutSession(session.id).catch(() => undefined); // session_not_open: it ran out
    expect(mock.session(session.id)!.status).toBe("expired");
    const types = ((await mock.listEvents(new Date(0))) as { type: string }[]).map((e) => e.type);
    expect(types).toContain("checkout.session.expired"); // current code: []
  });
});
