// Review d3r5: when an event's after-effects fail, applyParsed answers 500 although the event's transaction committed.
// reconcileEvents files that under notApplied ("Not applied ... the next run tries them again") and doesn't count it
// as processed, so its report says a payment that paid the invoice wasn't applied.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockProvider } from "@/server/billing/mock-provider";
import { reconcileEvents } from "@/server/billing/reconcile";
import { startCheckout } from "@/server/billing/service";
import type { WebhookDeps } from "@/server/billing/webhook";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import { appDb, unique } from "../helpers";

let app: Db;
beforeAll(() => {
  app = appDb({ max: 4 });
});
afterAll(async () => {
  await app.$disconnect();
});

const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};

describe("reconcileEvents report", () => {
  it("doesn't list an applied event as not applied when only its after-effects failed", async () => {
    const org = await app.organization.create({ data: { name: "Acme", slug: `rr-${unique()}` } });
    const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
    const invoiceId = await run(async (tx) => {
      const customerId = ok(await createCustomer(tx, { name: "N", email: `p-${unique()}@navy.example`, address: null }));
      const id = ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
      ok(await addLine(tx, id, { description: "Work", quantity: 1000n, unitPriceMinor: 5342n, taxRate: 0n }));
      ok(await finalize(tx, id, 30));
      return id;
    });
    const mock = new MockProvider({ webhookSecret: "whsec_rr", deliver: async () => undefined }); // endpoint down
    const link = ok(await startCheckout(run, invoiceId, { provider: mock, appBaseUrl: "http://localhost:8117", organizationName: "Acme" }));
    await mock.pay(link.url.split("/").at(-1)!);

    const deps: Omit<WebhookDeps, "secret" | "now"> = {
      run: (event, fn) => withTenant(event.organizationId, fn, app),
      organizationExists: async (id) => (await app.organization.count({ where: { id } })) === 1,
      afterApplied: async () => {
        throw new Error("provider unavailable");
      },
    };
    const report = await reconcileEvents(mock, new Date(Date.now() - 3_600_000), deps);
    const invoice = await run((tx) => tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { status: true } }));
    expect(invoice.status).toBe("PAID"); // the event was applied
    // Current code: { processed: 0, notApplied: [{ status: 500, result: "error" }] }.
    expect({ processed: report.processed, notApplied: report.notApplied.length }).toEqual({ processed: 1, notApplied: 0 });
  });
});
