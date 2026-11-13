// Review d3r6: round 5 made MockProvider emit checkout.session.expired only when open() happens to notice a session
// past expires_at (a pay/expire/lapse call). Stripe sends that event for every session that runs out, touched or
// not, so a session nobody touches after expiry is still silent: no delivery and nothing in listEvents, which is
// exactly the gap d3r5 reported ("reconciliation against the mock can then never record that expiry").
// Also: the noticed expiry is stamped with the time it was noticed, not expires_at, so a reconcile window that
// starts after expires_at includes it in the mock but would not in Stripe's log.
import { describe, expect, it } from "vitest";
import { MockProvider } from "@/server/billing/mock-provider";

const request = (key: string) => ({
  // Adapted (setup only): `as const` so the currency type-checks as a Currency (it was widened to string).
  amountMinor: 5342n, currency: "USD" as const, description: "Invoice", customerEmail: "p@navy.example",
  successUrl: "http://localhost:8117/s", cancelUrl: "http://localhost:8117/c",
  metadata: { organization_id: "00000000-0000-4000-8000-00000000000a", invoice_id: "00000000-0000-4000-8000-00000000000b" },
  idempotencyKey: key,
});

describe("MockProvider expiry events", () => {
  it("sends checkout.session.expired for a session that ran out without anyone touching it", async () => {
    let clock = 1_763_000_000;
    const delivered: string[] = [];
    const mock = new MockProvider({ webhookSecret: "whsec_untouched", now: () => clock, deliver: async (d) => void delivered.push(d.type) });
    await mock.createCheckoutSession(request("untouched-1"));
    clock += 25 * 3600;
    const types = ((await mock.listEvents(new Date(0))) as { type: string }[]).map((e) => e.type);
    expect({ logged: types, delivered }).toEqual({ logged: ["checkout.session.expired"], delivered: ["checkout.session.expired"] }); // current: [] and []
  });

  it("dates a noticed expiry at expires_at, as Stripe's event would be", async () => {
    let clock = 1_763_000_000;
    const mock = new MockProvider({ webhookSecret: "whsec_untouched", now: () => clock });
    const session = await mock.createCheckoutSession(request("untouched-2"));
    clock += 30 * 24 * 3600; // noticed a month later
    await mock.pay(session.id).catch(() => undefined);
    const events = (await mock.listEvents(new Date(0))) as { type: string; created: number }[];
    expect(events.map((e) => [e.type, e.created])).toEqual([["checkout.session.expired", Math.floor(session.expiresAt.getTime() / 1000)]]); // current: created = the month-later clock
  });
});
