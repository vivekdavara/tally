// The billing tables as the database enforces them (migrations/*_billing), for any writer: a payment is created
// pending, for an open invoice's exact total; afterwards only its outcome changes, along the allowed transitions;
// at most one live attempt per invoice; nothing is deleted except by the organization's own deletion; an event's
// outcome is written once. These tests go around the services on purpose.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { sqlState } from "@/server/db/errors";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize, voidInvoice } from "@/server/invoices/service";
import { adminDb, appDb, unique } from "../helpers";

let app: Db;
let admin: Db;

beforeAll(() => {
  app = appDb({ max: 4 });
  admin = adminDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

const ok = <T,>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

/** An organization with one OPEN invoice of 12.34 USD (2 x 6.17). */
async function openInvoice(): Promise<{ orgId: string; invoiceId: string; run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T> }> {
  const org = await app.organization.create({ data: { name: "Bill", slug: `bill-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const invoiceId = await run(async (tx) => {
    const customerId = ok(await createCustomer(tx, { name: "C", email: `c-${unique()}@example.com`, address: null }));
    const id = ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
    ok(await addLine(tx, id, { description: "Work", quantity: 2000n, unitPriceMinor: 617n, taxRate: 0n }));
    ok(await finalize(tx, id, 30));
    return id;
  });
  return { orgId: org.id, invoiceId, run };
}

const session = () => `cs_test_${unique()}`;

function paymentData(orgId: string, invoiceId: string, over: Record<string, unknown> = {}) {
  const id = session();
  return {
    organizationId: orgId,
    invoiceId,
    provider: "mock",
    checkoutSessionId: id,
    checkoutUrl: `/mock-checkout/${id}`,
    amountMinor: 1234n,
    currency: "USD",
    expiresAt: new Date(Date.now() + 86_400_000),
    ...over,
  };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    // The SQLSTATE alone when it's one of ours (TL...), else the state and message (a CHECK's name is in it).
    const state = sqlState(error);
    return state?.startsWith("TL") ? state : `${state ?? ""} ${(error as Error).message}`;
  }
  return "no error";
}

describe("creating a payment", () => {
  it("works for an open invoice's exact total and starts pending", async () => {
    const { orgId, invoiceId, run } = await openInvoice();
    const created = await run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId) }));
    expect(created).toMatchObject({ status: "PENDING", amountMinor: 1234n, refundDue: false, paidAt: null });
  });

  it("is refused for another amount or currency (TL013)", async () => {
    const { orgId, invoiceId, run } = await openInvoice();
    expect(await code(run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId, { amountMinor: 1233n }) })))).toBe("TL013");
    expect(await code(run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId, { currency: "EUR" }) })))).toBe("TL013");
  });

  it("is refused for a draft, a void or a paid invoice (TL012)", async () => {
    const { orgId, invoiceId, run } = await openInvoice();
    const draftId = await run(async (tx) => {
      const customerId = (await tx.customer.findFirstOrThrow({ select: { id: true } })).id;
      return ok(await createDraft(tx, { customerId, currency: "USD", memo: null }));
    });
    expect(await code(run((tx) => tx.payment.create({ data: paymentData(orgId, draftId) })))).toBe("TL012");
    await run((tx) => voidInvoice(tx, invoiceId));
    expect(await code(run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId) })))).toBe("TL012");
  });

  it("can't start in another state, even for a superuser (TL011)", async () => {
    const { orgId, invoiceId } = await openInvoice();
    const data = paymentData(orgId, invoiceId);
    const result = await code(
      admin.$executeRaw`INSERT INTO payments (organization_id, invoice_id, provider, checkout_session_id, checkout_url, amount_minor, currency, expires_at, status, paid_at)
                        VALUES (${orgId}::uuid, ${invoiceId}::uuid, 'mock', ${data.checkoutSessionId}, ${data.checkoutUrl}, 1234, 'USD', now(), 'SUCCEEDED', now())`,
    );
    expect(result).toBe("TL011");
  });

  it("allows one live attempt per invoice; a new one once the first has ended", async () => {
    const { orgId, invoiceId, run } = await openInvoice();
    const first = await run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId) }));
    const second = await code(run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId) })));
    expect(second).toMatch(/payments_one_live_per_invoice|P2002|Unique constraint/);
    await run((tx) => tx.payment.update({ where: { id: first.id }, data: { status: "EXPIRED" } }));
    await expect(run((tx) => tx.payment.create({ data: paymentData(orgId, invoiceId) }))).resolves.toMatchObject({ status: "PENDING" });
  });

  it("is refused for another organization's invoice like a missing one", async () => {
    const a = await openInvoice();
    const b = await openInvoice();
    // Row security hides b's invoice from a's transaction; the trigger finds nothing.
    expect(await code(a.run((tx) => tx.payment.create({ data: paymentData(a.orgId, b.invoiceId) })))).toBe("TL012");
  });
});

describe("a payment's outcome", () => {
  async function pending() {
    const ctx = await openInvoice();
    const payment = await ctx.run((tx) => tx.payment.create({ data: paymentData(ctx.orgId, ctx.invoiceId) }));
    const set = (data: Record<string, unknown>) => ctx.run((tx) => tx.payment.update({ where: { id: payment.id }, data }));
    return { ...ctx, payment, set };
  }

  it("moves PENDING -> PROCESSING -> SUCCEEDED with paid_at and the intent", async () => {
    const { set } = await pending();
    await set({ status: "PROCESSING" });
    await expect(set({ status: "SUCCEEDED", paidAt: new Date(), paymentIntentId: "pi_test_1" })).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("records a late success after EXPIRED or FAILED", async () => {
    const a = await pending();
    await a.set({ status: "EXPIRED" });
    await expect(a.set({ status: "SUCCEEDED", paidAt: new Date() })).resolves.toMatchObject({ status: "SUCCEEDED" });
    const b = await pending();
    await b.set({ status: "FAILED" });
    await expect(b.set({ status: "SUCCEEDED", paidAt: new Date() })).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it.each([
    ["SUCCEEDED", "FAILED"],
    ["SUCCEEDED", "EXPIRED"],
    ["SUCCEEDED", "PENDING"],
    ["EXPIRED", "PENDING"],
    ["FAILED", "PROCESSING"],
    ["PROCESSING", "EXPIRED"],
  ])("can't go from %s to %s (TL015)", async (from, to) => {
    const { set } = await pending();
    await set(from === "SUCCEEDED" ? { status: from, paidAt: new Date() } : { status: from });
    // Only the status: the trigger refuses the transition before the CHECK on paid_at is evaluated.
    expect(await code(set({ status: to }))).toBe("TL015");
  });

  it("needs paid_at exactly when SUCCEEDED (a CHECK)", async () => {
    const { set } = await pending();
    expect(await code(set({ status: "SUCCEEDED" }))).toMatch(/payments_paid_at_when_succeeded/);
  });

  it("can't undo refund_due, the intent or paid_at (TL014)", async () => {
    const { set } = await pending();
    await set({ status: "SUCCEEDED", paidAt: new Date("2026-11-13T15:00:00Z"), paymentIntentId: "pi_test_a", refundDue: true });
    expect(await code(set({ refundDue: false }))).toBe("TL014");
    expect(await code(set({ paymentIntentId: "pi_test_b" }))).toBe("TL014");
    expect(await code(set({ paidAt: new Date("2026-11-13T16:00:00Z") }))).toBe("TL014");
  });

  it("freezes what the payment is for, against the application (no grant) and a superuser (TL014)", async () => {
    const { payment } = await pending();
    const appResult = await code(app.$executeRaw`UPDATE payments SET amount_minor = 1 WHERE id = ${payment.id}::uuid`);
    expect(appResult).toMatch(/permission denied|42501/);
    for (const column of ["amount_minor = 1", "currency = 'EUR'", "checkout_url = '/elsewhere'", "expires_at = now()", "provider = 'stripe'"]) {
      expect(await code(admin.$executeRawUnsafe(`UPDATE payments SET ${column} WHERE id = '${payment.id}'`))).toBe("TL014");
    }
  });

  it("is never deleted, except with its organization (TL014)", async () => {
    const { orgId, invoiceId, payment } = await pending();
    expect(await code(admin.$executeRaw`DELETE FROM payments WHERE id = ${payment.id}::uuid`)).toBe("TL014");
    expect(await code(app.$executeRaw`DELETE FROM payments WHERE id = ${payment.id}::uuid`)).toMatch(/permission denied|42501/);
    // A paid invoice, its payment and an event all go with the organization.
    await admin.$executeRaw`UPDATE payments SET status = 'SUCCEEDED', paid_at = now() WHERE id = ${payment.id}::uuid`;
    await admin.$executeRaw`UPDATE invoices SET status = 'PAID' WHERE id = ${invoiceId}::uuid`;
    await admin.$executeRaw`INSERT INTO stripe_events (id, organization_id, type, payment_id, outcome, stripe_created_at)
                            VALUES (${`evt_test_${unique()}`}, ${orgId}::uuid, 'checkout.session.completed', ${payment.id}::uuid, 'invoice-paid', now())`;
    await admin.$executeRaw`DELETE FROM organizations WHERE id = ${orgId}::uuid`;
    const left = await admin.$queryRaw<{ n: bigint }[]>`SELECT (SELECT count(*) FROM payments WHERE organization_id = ${orgId}::uuid)
                                                        + (SELECT count(*) FROM stripe_events WHERE organization_id = ${orgId}::uuid) AS n`;
    expect(left[0]!.n).toBe(0n);
  });
});

describe("stripe_events", () => {
  it("takes an event id once; a second insert of it does nothing", async () => {
    const { orgId, run } = await openInvoice();
    const id = `evt_test_${unique()}`;
    const insert = () =>
      run((tx) => tx.$queryRaw<{ id: string }[]>`
        INSERT INTO stripe_events (id, organization_id, type, stripe_created_at)
        VALUES (${id}, ${orgId}::uuid, 'checkout.session.completed', now())
        ON CONFLICT (id) DO NOTHING RETURNING id`);
    expect(await insert()).toEqual([{ id }]);
    expect(await insert()).toEqual([]);
  });

  it("writes an outcome once (TL016) and nothing else", async () => {
    const { orgId, run } = await openInvoice();
    const id = `evt_test_${unique()}`;
    await run((tx) => tx.stripeEvent.create({ data: { id, organizationId: orgId, type: "checkout.session.expired", stripeCreatedAt: new Date() } }));
    await run((tx) => tx.stripeEvent.update({ where: { id }, data: { outcome: "stale" } }));
    expect(await code(run((tx) => tx.stripeEvent.update({ where: { id }, data: { outcome: "invoice-paid" } })))).toBe("TL016");
    expect(await code(admin.$executeRaw`UPDATE stripe_events SET type = 'x.y' WHERE id = ${id}`)).toBe("TL016");
    expect(await code(admin.$executeRaw`DELETE FROM stripe_events WHERE id = ${id}`)).toBe("TL016");
  });

  it("refuses ids, types and outcomes of the wrong shape", async () => {
    const { orgId, run } = await openInvoice();
    const make = (id: string, type = "checkout.session.completed") =>
      code(run((tx) => tx.stripeEvent.create({ data: { id, organizationId: orgId, type, stripeCreatedAt: new Date() } })));
    expect(await make("evt_")).toMatch(/stripe_events_id_format/);
    expect(await make("evt_a'b")).toMatch(/stripe_events_id_format/);
    expect(await make(`evt_${unique()}`, "Checkout Session")).toMatch(/stripe_events_type_format/);
  });

  it("is invisible to another organization", async () => {
    const a = await openInvoice();
    const b = await openInvoice();
    const id = `evt_test_${unique()}`;
    await a.run((tx) => tx.stripeEvent.create({ data: { id, organizationId: a.orgId, type: "checkout.session.completed", stripeCreatedAt: new Date() } }));
    expect(await b.run((tx) => tx.stripeEvent.count({ where: { id } }))).toBe(0);
    expect(await a.run((tx) => tx.stripeEvent.count({ where: { id } }))).toBe(1);
  });
});
