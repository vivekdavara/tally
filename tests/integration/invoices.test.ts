// The invoice life cycle as the database enforces it (migrations/*_invoicing) and the services use it:
// finalization numbers invoices with no gaps, even with concurrent finalizations and rollbacks; totals are
// stored by the database and agree with money.ts; final invoices and their lines can't change; and a line
// write racing a finalization waits for it and is then refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { computeTotals } from "@/server/invoices/money";
import {
  addLine,
  createCustomer,
  createDraft,
  deleteCustomer,
  deleteDraft,
  finalize,
  getInvoice,
  listInvoices,
  markPaid,
  refusals,
  removeLine,
  updateLine,
  voidInvoice,
} from "@/server/invoices/service";
import { adminDb, appDb, unique } from "../helpers";

let app: Db;
let admin: Db;

beforeAll(() => {
  app = appDb({ max: 6 });
  admin = adminDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

async function newOrg(): Promise<{ id: string; run: <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>; customerId: string }> {
  const org = await app.organization.create({ data: { name: "Inv", slug: `inv-${unique()}` } });
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(org.id, fn, app);
  const created = await run((tx) => createCustomer(tx, { name: "Customer", email: `c-${unique()}@example.com`, address: null }));
  if (!created.ok) throw new Error(created.reason);
  return { id: org.id, run, customerId: created.value };
}

const value = <T,>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
};

const line = (quantity: bigint, unitPriceMinor: bigint, taxRate = 0n) => ({ description: "Work", quantity, unitPriceMinor, taxRate });

async function draftWithLines(org: Awaited<ReturnType<typeof newOrg>>, lines = [line(1000n, 100n)]): Promise<string> {
  return org.run(async (tx) => {
    const id = value(await createDraft(tx, { customerId: org.customerId, currency: "USD", memo: null }));
    for (const l of lines) value(await addLine(tx, id, l));
    return id;
  });
}

describe("finalization", () => {
  it("numbers an organization's invoices 1, 2, 3 and stores the totals money.ts computes", async () => {
    const org = await newOrg();
    const lines = [line(1500n, 333n, 8875n), line(2000n, 1999n, 20000n), line(1000n, 10n)];
    const ids = [await draftWithLines(org, lines), await draftWithLines(org), await draftWithLines(org)];
    const numbers = [];
    for (const id of ids) numbers.push(value(await org.run((tx) => finalize(tx, id, 30))));
    expect(numbers).toEqual([1, 2, 3]);
    const first = (await org.run((tx) => getInvoice(tx, ids[0]!)))!;
    const expected = computeTotals(lines);
    expect(first.totals).toEqual(expected);
    expect(first).toMatchObject({ status: "OPEN", number: 1 });
    const stored = await org.run((tx) =>
      tx.invoice.findUniqueOrThrow({ where: { id: ids[0]! }, select: { subtotalMinor: true, taxMinor: true, totalMinor: true, issuedAt: true, dueOn: true } }),
    );
    expect(stored).toMatchObject({ subtotalMinor: expected.subtotal, taxMinor: expected.tax, totalMinor: expected.total });
    // Due 30 days after the issue date (UTC).
    const issued = stored.issuedAt!;
    const dueDays = (stored.dueOn!.getTime() - Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth(), issued.getUTCDate())) / 86_400_000;
    expect(dueDays).toBe(30);
  });

  it("numbers each organization separately", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    expect(value(await a.run(async (tx) => finalize(tx, await draftWithLines(a), 0)))).toBe(1);
    expect(value(await b.run(async (tx) => finalize(tx, await draftWithLines(b), 0)))).toBe(1);
    expect(value(await a.run(async (tx) => finalize(tx, await draftWithLines(a), 0)))).toBe(2);
  });

  it("hands a rolled-back number to the next finalization", async () => {
    const org = await newOrg();
    const [x, y] = [await draftWithLines(org), await draftWithLines(org)];
    await expect(
      org.run(async (tx) => {
        expect(value(await finalize(tx, x, 0))).toBe(1);
        throw new Error("the request failed after finalizing");
      }),
    ).rejects.toThrow(/after finalizing/);
    expect(value(await org.run((tx) => finalize(tx, y, 0)))).toBe(1);
    expect(value(await org.run((tx) => finalize(tx, x, 0)))).toBe(2);
  });

  it("leaves no gaps and no repeats with 40 concurrent finalizations, a quarter of them rolled back", async () => {
    const org = await newOrg();
    const ids = await Promise.all(Array.from({ length: 40 }, () => draftWithLines(org)));
    const outcomes = await Promise.allSettled(
      ids.map((id, i) =>
        org.run(async (tx) => {
          const n = value(await finalize(tx, id, 0));
          if (i % 4 === 0) throw new Error("rolled back");
          return n;
        }),
      ),
    );
    const committed = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
    const failed = outcomes.filter((o) => o.status === "rejected").map((o) => String((o as PromiseRejectedResult).reason));
    expect(failed).toHaveLength(10);
    expect(failed.every((reason) => reason.includes("rolled back"))).toBe(true);
    expect([...committed].sort((p, q) => p - q)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    const stored = await org.run((tx) => tx.invoice.findMany({ where: { status: "OPEN" }, select: { number: true } }));
    expect(stored.map((r) => r.number).sort((p, q) => p! - q!)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    // Issue times follow the numbers: each finalization takes its time after it has its number.
    const ordered = await org.run((tx) => tx.invoice.findMany({ where: { status: "OPEN" }, orderBy: { number: "asc" }, select: { issuedAt: true } }));
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]!.issuedAt!.getTime()).toBeGreaterThanOrEqual(ordered[i - 1]!.issuedAt!.getTime());
  });

  it("refuses an invoice with no lines, and terms outside 0-365 days", async () => {
    const org = await newOrg();
    const empty = await org.run(async (tx) => value(await createDraft(tx, { customerId: org.customerId, currency: "USD", memo: null })));
    expect(await org.run((tx) => finalize(tx, empty, 30))).toEqual({ ok: false, reason: "no-lines" });
    const full = await draftWithLines(org);
    expect(await org.run((tx) => finalize(tx, full, -1))).toEqual({ ok: false, reason: "bad-terms" });
    expect(await org.run((tx) => finalize(tx, full, 366))).toEqual({ ok: false, reason: "bad-terms" });
    // The trigger refuses an empty invoice too, for a writer that skips the service's check.
    await expect(
      refusals(() =>
        org.run(async (tx) => {
          await tx.$executeRaw`UPDATE invoices SET status = 'OPEN', due_on = current_date + 1 WHERE id = ${empty}::uuid`;
          return { ok: true as const, value: undefined };
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "no-lines" });
  });

  it("refuses a due date before the issue date (the trigger's check)", async () => {
    const org = await newOrg();
    const id = await draftWithLines(org);
    await expect(
      refusals(() =>
        org.run(async (tx) => {
          await tx.$executeRaw`UPDATE invoices SET status = 'OPEN', due_on = current_date - 2 WHERE id = ${id}::uuid`;
          return { ok: true as const, value: undefined };
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "bad-terms" });
  });
});

describe("a final invoice", () => {
  let org: Awaited<ReturnType<typeof newOrg>>;
  let id: string;
  let lineId: string;

  beforeAll(async () => {
    org = await newOrg();
    id = await draftWithLines(org);
    lineId = (await org.run((tx) => tx.invoiceLine.findFirstOrThrow({ where: { invoiceId: id } }))).id;
    value(await org.run((tx) => finalize(tx, id, 14)));
  });

  it("can't be finalized again, edited or deleted through the services", async () => {
    expect(await org.run((tx) => finalize(tx, id, 0))).toEqual({ ok: false, reason: "final" });
    expect(await org.run((tx) => addLine(tx, id, line(1000n, 1n)))).toEqual({ ok: false, reason: "final" });
    expect(await org.run((tx) => updateLine(tx, id, lineId, line(1000n, 1n)))).toEqual({ ok: false, reason: "final" });
    expect(await org.run((tx) => removeLine(tx, id, lineId))).toEqual({ ok: false, reason: "final" });
    expect(await org.run((tx) => deleteDraft(tx, id))).toEqual({ ok: false, reason: "final" });
  });

  // Each as a writer that skips the services' checks would try it: the triggers refuse.
  it.each([
    ["insert a line", (tx: TenantTx) => tx.$executeRaw`INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor) SELECT organization_id, id, 99, 'x', 1, 1 FROM invoices WHERE id = ${id}::uuid`, "final"],
    ["change a line", (tx: TenantTx) => tx.$executeRaw`UPDATE invoice_lines SET unit_price_minor = 1 WHERE id = ${lineId}::uuid`, "final"],
    ["delete a line", (tx: TenantTx) => tx.$executeRaw`DELETE FROM invoice_lines WHERE id = ${lineId}::uuid`, "final"],
    ["change its memo", (tx: TenantTx) => tx.$executeRaw`UPDATE invoices SET memo = 'later' WHERE id = ${id}::uuid`, "final"],
    ["change its due date", (tx: TenantTx) => tx.$executeRaw`UPDATE invoices SET due_on = due_on + 1 WHERE id = ${id}::uuid`, "final"],
    ["delete it", (tx: TenantTx) => tx.$executeRaw`DELETE FROM invoices WHERE id = ${id}::uuid`, "final"],
    ["send it back to draft", (tx: TenantTx) => tx.$executeRaw`UPDATE invoices SET status = 'DRAFT' WHERE id = ${id}::uuid`, "not-open"],
  ])("refuses to %s", async (_, write, reason) => {
    await expect(
      refusals(() =>
        org.run(async (tx) => {
          await write(tx);
          return { ok: true as const, value: undefined };
        }),
      ),
    ).resolves.toEqual({ ok: false, reason });
  });

  it("moves only OPEN → PAID or OPEN → VOID, and PAID and VOID are final", async () => {
    const paid = await draftWithLines(org);
    value(await org.run((tx) => finalize(tx, paid, 0)));
    expect(await org.run((tx) => markPaid(tx, paid))).toEqual({ ok: true, value: undefined });
    expect(await org.run((tx) => voidInvoice(tx, paid))).toEqual({ ok: false, reason: "not-open" });
    expect(await org.run((tx) => markPaid(tx, paid))).toEqual({ ok: false, reason: "not-open" });
    const voided = await draftWithLines(org);
    expect(await org.run((tx) => voidInvoice(tx, voided))).toEqual({ ok: false, reason: "not-open" }); // a draft
    value(await org.run((tx) => finalize(tx, voided, 0)));
    expect(await org.run((tx) => voidInvoice(tx, voided))).toEqual({ ok: true, value: undefined });
    expect(await org.run((tx) => markPaid(tx, voided))).toEqual({ ok: false, reason: "not-open" });
    // The raw path: PAID → VOID refused by the trigger, and a draft can't be marked paid.
    await expect(
      refusals(() =>
        org.run(async (tx) => {
          await tx.$executeRaw`UPDATE invoices SET status = 'VOID' WHERE id = ${paid}::uuid`;
          return { ok: true as const, value: undefined };
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "not-open" });
    const draft = await draftWithLines(org);
    await expect(
      refusals(() =>
        org.run(async (tx) => {
          await tx.$executeRaw`UPDATE invoices SET status = 'PAID' WHERE id = ${draft}::uuid`;
          return { ok: true as const, value: undefined };
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "not-open" });
  });

  it("keeps its customer from being deleted", async () => {
    expect(await org.run((tx) => deleteCustomer(tx, org.customerId))).toEqual({ ok: false, reason: "has-invoices" });
  });
});

describe("drafts", () => {
  it("number their lines 1, 2, 3, can delete them, and are deleted with their lines", async () => {
    const org = await newOrg();
    const id = await draftWithLines(org, [line(1000n, 1n), line(1000n, 2n), line(1000n, 3n)]);
    const view = (await org.run((tx) => getInvoice(tx, id)))!;
    expect(view.lines.map((l) => l.position)).toEqual([1, 2, 3]);
    value(await org.run((tx) => removeLine(tx, id, view.lines[1]!.id)));
    value(await org.run((tx) => addLine(tx, id, line(1000n, 4n))));
    expect((await org.run((tx) => getInvoice(tx, id)))!.lines.map((l) => [l.position, l.unitPriceMinor])).toEqual([
      [1, 1n],
      [3, 3n],
      [4, 4n],
    ]);
    value(await org.run((tx) => deleteDraft(tx, id)));
    expect(await org.run((tx) => tx.invoiceLine.count({ where: { invoiceId: id } }))).toBe(0);
  });

  it("stop at 100 lines, in the service and in the trigger", async () => {
    const org = await newOrg();
    const id = await draftWithLines(org, Array.from({ length: 100 }, () => line(1000n, 1n)));
    expect(await org.run((tx) => addLine(tx, id, line(1000n, 1n)))).toEqual({ ok: false, reason: "too-many-lines" });
    await expect(
      refusals(() =>
        org.run(async (tx) => {
          await tx.$executeRaw`INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor)
                               SELECT organization_id, id, 101, 'x', 1, 1 FROM invoices WHERE id = ${id}::uuid`;
          return { ok: true as const, value: undefined };
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "too-many-lines" });
  });

  it("can't use another organization's customer, which reads as missing", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    expect(await a.run((tx) => createDraft(tx, { customerId: b.customerId, currency: "USD", memo: null }))).toEqual({ ok: false, reason: "no-customer" });
    expect(await a.run((tx) => createDraft(tx, { customerId: crypto.randomUUID(), currency: "USD", memo: null }))).toEqual({ ok: false, reason: "no-customer" });
  });

  it("aren't visible to another organization: its ids behave like missing ones", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    const id = await draftWithLines(a);
    expect(await b.run((tx) => getInvoice(tx, id))).toBeNull();
    expect(await b.run((tx) => finalize(tx, id, 0))).toEqual({ ok: false, reason: "not-found" });
    expect(await b.run((tx) => addLine(tx, id, line(1000n, 1n)))).toEqual({ ok: false, reason: "not-found" });
    expect(await b.run((tx) => deleteDraft(tx, id))).toEqual({ ok: false, reason: "not-found" });
    expect(await b.run((tx) => listInvoices(tx))).toEqual([]);
  });
});

describe("a line write racing a finalization", () => {
  it("waits for the finalization's lock, then is refused: the stored totals never miss a line", async () => {
    const org = await newOrg();
    const id = await draftWithLines(org);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let finalized!: () => void;
    const numbered = new Promise<void>((resolve) => (finalized = resolve));
    const finalizing = org.run(async (tx) => {
      const n = value(await finalize(tx, id, 0));
      finalized();
      await gate;
      return n;
    });
    await numbered;
    // A writer that skips the service's lock: its trigger waits on the invoice row the finalization holds.
    const racing = refusals(() =>
      org.run(async (tx) => {
        await tx.$executeRaw`INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor)
                             SELECT organization_id, id, 50, 'late', 1, 999 FROM invoices WHERE id = ${id}::uuid`;
        return { ok: true as const, value: undefined };
      }),
    );
    // Wait until the insert is blocked on a lock (seen from a superuser connection), then let the
    // finalization commit.
    for (let i = 0; i < 100; i++) {
      const waiting = await admin.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%''late''%'`;
      if ((waiting[0]?.n ?? 0n) > 0n) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const blocked = await admin.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%''late''%'`;
    expect(blocked[0]?.n).toBe(1n);
    release();
    expect(await finalizing).toBe(1);
    expect(await racing).toEqual({ ok: false, reason: "final" });
    const view = (await org.run((tx) => getInvoice(tx, id)))!;
    expect(view.lines).toHaveLength(1);
    expect(view.totals.total).toBe(100n);
  });
});

describe("deleting an organization", () => {
  it("takes its final invoices with it (the guard lets the organization's own cascade through)", async () => {
    const org = await newOrg();
    value(await org.run(async (tx) => finalize(tx, await draftWithLines(org), 0)));
    // As a superuser, in a transaction that rolls back: the application can't delete organizations at all.
    await expect(
      admin.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM organizations WHERE id = ${org.id}::uuid`;
        const left = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM invoices WHERE organization_id = ${org.id}::uuid`;
        expect(left[0]?.n).toBe(0n);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow(/rolled back/);
  });
});
