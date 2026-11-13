// Review D3: startCheckout maps a violation of payments_one_live_per_invoice to fail("checkout-busy"), but the insert
// is a $queryRaw, whose error (P2010, "Raw query failed. Code: 23505") violatedUniqueConstraint does not recognise:
// the second of two different sessions racing for one invoice throws (a 500) instead, and its session is never
// expired at the provider.
import { afterAll, beforeAll, expect, it } from "vitest";
import { MockProvider } from "@/server/billing/mock-provider";
import type { BillingProvider } from "@/server/billing/provider";
import { startCheckout } from "@/server/billing/service";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import { appDb, unique } from "../helpers";
let app: Db;
beforeAll(() => { app = appDb({ max: 4 }); });
afterAll(async () => app.$disconnect());
const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => { if (!r.ok) throw new Error(r.reason); return r.value; };
it("two different sessions at once: one link, the other checkout-busy", async () => {
  const org = await app.organization.create({ data: { name: "Acme", slug: `rv3b-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const invoiceId = await run(async (tx) => {
    const customerId = ok(await createCustomer(tx, { name: "N", email: `p-${unique()}@navy.example`, address: null }));
    const id = ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
    ok(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor: 5342n, taxRate: 0n }));
    ok(await finalize(tx, id, 30));
    return id;
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const gated = (p: MockProvider): BillingProvider => ({ name: "mock", expireCheckoutSession: (id) => p.expireCheckoutSession(id),
    createCheckoutSession: async (req) => { const s = await p.createCheckoutSession(req); if (++n === 2) release(); await gate; return s; } });
  const d = (p: BillingProvider) => ({ provider: p, appBaseUrl: "http://localhost:8117", organizationName: "Acme" });
  const results = await Promise.allSettled([startCheckout(run, invoiceId, d(gated(new MockProvider({ webhookSecret: "x" })))), startCheckout(run, invoiceId, d(gated(new MockProvider({ webhookSecret: "x" }))))]);
  const outcomes = results.map((r) => (r.status === "fulfilled" ? (r.value.ok ? "ok" : r.value.reason) : `threw: ${String(r.reason).split("\n").at(-1)}`)).sort();
  expect(outcomes).toEqual(["checkout-busy", "ok"]);
});
