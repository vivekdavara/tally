// Shared setup for the d3r2 review tests: an open invoice whose first attempt (A) is EXPIRED and whose newer link
// (B) is PENDING, the state 868b60c's afterApplied hook is for.
import { MockProvider, type SignedDelivery } from "@/server/billing/mock-provider";
import { startCheckout } from "@/server/billing/service";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import { unique } from "../helpers";

export const SECRET = "whsec_review_d3r2_secret";
export const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};
const sessionIdOf = (url: string) => url.split("/").at(-1)!;

export async function abandonedThenNewer(app: Db) {
  const org = await app.organization.create({ data: { name: "Acme", slug: `rv3r2-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const invoiceId = await run(async (tx) => {
    const customerId = ok(await createCustomer(tx, { name: "N", email: `p-${unique()}@navy.example`, address: null }));
    const id = ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
    ok(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor: 5342n, taxRate: 0n }));
    ok(await finalize(tx, id, 30));
    return id;
  });
  const delivered: SignedDelivery[] = [];
  let skew = 86_400 + 600;
  const provider = new MockProvider({ webhookSecret: SECRET, now: () => Math.floor(Date.now() / 1000) - skew, deliver: async (d) => void delivered.push(d) });
  const deps = (p = provider) => ({ provider: p, appBaseUrl: "http://localhost:8117", organizationName: "Acme" });
  const a = sessionIdOf(ok(await startCheckout(run, invoiceId, deps())).url);
  skew = 0;
  const b = sessionIdOf(ok(await startCheckout(run, invoiceId, deps())).url);
  const lateA = provider.event("checkout.session.completed", { ...provider.session(a)!, status: "complete", paymentStatus: "paid", paymentIntent: "pi_mock_late" });
  return { org, run, invoiceId, provider, delivered, a, b, lateA };
}
