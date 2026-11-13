// Review D3: startCheckout accepts an upper-case invoice id (its UUID check is case-insensitive, and Postgres
// matches it), and writes that id into the session's metadata as given. The webhook parser's UUID check is
// lower-case only, so every event for that session is acknowledged as "not-a-tally-session": the customer's money
// arrives and is never recorded, the invoice stays OPEN.
import { afterAll, beforeAll, expect, it } from "vitest";
import { MockProvider, type SignedDelivery } from "@/server/billing/mock-provider";
import { listPayments, startCheckout } from "@/server/billing/service";
import { handleStripeWebhook, type WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import { appDb, unique } from "../helpers";

const SECRET = "whsec_review_d3_secret";
let app: Db;
let deps: WebhookDeps;

beforeAll(() => {
  app = appDb({ max: 4 });
  deps = {
    secret: SECRET,
    run: (event, fn) => withTenant(event.organizationId, fn, app),
    organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
  };
});
afterAll(async () => app.$disconnect());

const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};

it("an invoice id given in upper case still gets its payment recorded", async () => {
  const org = await app.organization.create({ data: { name: "Acme", slug: `rv3-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const invoiceId = await run(async (tx) => {
    const customerId = ok(await createCustomer(tx, { name: "Navy Yard", email: `p-${unique()}@navy.example`, address: null }));
    const id = ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
    ok(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor: 5342n, taxRate: 0n }));
    ok(await finalize(tx, id, 30));
    return id;
  });
  const delivered: SignedDelivery[] = [];
  const provider = new MockProvider({ webhookSecret: SECRET, deliver: async (d) => void delivered.push(d) });
  const { url } = ok(await startCheckout(run, invoiceId.toUpperCase(), { provider, appBaseUrl: "http://localhost:8117", organizationName: "Acme" }));
  const paid = await provider.pay(url.split("/").at(-1)!);
  // The customer paid: the event must be applied, not acknowledged and dropped.
  expect((await handleStripeWebhook(paid.body, paid.header, deps)).body).toEqual({ result: "processed", outcome: "invoice-paid" });
  const payments = await run((tx) => listPayments(tx, invoiceId));
  expect(payments.map((p) => p.status)).toEqual(["SUCCEEDED"]);
});
