// The stored totals come from SQL (invoice_totals(), used by the finalization trigger); every page and PDF
// computes them in TypeScript (money.ts). getInvoice refuses to show an invoice whose two answers differ, so
// they must agree on every input. This compares them on random invoices, including the rounding edges
// (exact halves) and the limits, in one transaction that rolls back.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { computeTotals, MAX_QUANTITY, MAX_TAX_RATE, MAX_UNIT_PRICE_MINOR, type LineInput } from "@/server/invoices/money";
import { appDb, unique } from "../helpers";
import { rng } from "../rng";

let app: Db;
let orgId: string;

beforeAll(async () => {
  app = appDb({ max: 1 });
  orgId = (await app.organization.create({ data: { name: "Diff", slug: `diff-${unique()}` } })).id;
});

afterAll(async () => {
  await app.$disconnect();
});

const thousandths = (v: bigint) => `${v / 1000n}.${(v % 1000n).toString().padStart(3, "0")}`;

function randomInvoice(next: (below: bigint) => bigint, i: number): LineInput[] {
  const rates = [0n, 5000n, 8875n, 20000n, 7n, 12500n, MAX_TAX_RATE];
  const count = Number(next(10n)) + 1;
  return Array.from({ length: count }, () => {
    switch (i % 4) {
      // Exact halves: quantity 0.5 or 1.5 times an odd price, and a 50% rate on odd bases.
      case 0:
        return { quantity: [500n, 1500n, 2500n][Number(next(3n))]!, unitPriceMinor: 2n * next(1000n) + 1n, taxRate: 50000n };
      // Near the limits.
      case 1:
        return { quantity: MAX_QUANTITY - next(3n), unitPriceMinor: MAX_UNIT_PRICE_MINOR - next(3n), taxRate: rates[Number(next(7n))]! };
      default:
        return { quantity: next(MAX_QUANTITY) + 1n, unitPriceMinor: next(100_000n), taxRate: rates[Number(next(7n))]! };
    }
  });
}

describe("invoice totals", () => {
  it("are the same from SQL (invoice_totals) and from money.ts on 600 random invoices", async () => {
    const next = rng(42n);
    const invoices = Array.from({ length: 600 }, (_, i) => randomInvoice(next, i));
    const mismatches: string[] = [];
    let perLineDiffers = 0;
    await expect(
      withTenant(
        orgId,
        async (tx) => {
          const customer = await tx.customer.create({ data: { organizationId: orgId, name: "D", email: `d-${unique()}@example.com` } });
          for (const [i, lines] of invoices.entries()) {
            const invoice = await tx.invoice.create({ data: { organizationId: orgId, customerId: customer.id, currency: "USD" } });
            await tx.$executeRaw`
              INSERT INTO invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price_minor, tax_rate)
              SELECT ${orgId}::uuid, ${invoice.id}::uuid, p, 'x', q::numeric, u::bigint, r::numeric
              FROM unnest(${lines.map((_, j) => j + 1)}::int[], ${lines.map((l) => thousandths(l.quantity))}::text[],
                          ${lines.map((l) => l.unitPriceMinor.toString())}::text[], ${lines.map((l) => thousandths(l.taxRate))}::text[])
                   AS t(p, q, u, r)`;
            const sql = await tx.$queryRaw<{ subtotal_minor: bigint; tax_minor: bigint }[]>`
              SELECT subtotal_minor, tax_minor FROM invoice_totals(${orgId}::uuid, ${invoice.id}::uuid)`;
            const ts = computeTotals(lines);
            const row = sql[0]!;
            if (row.subtotal_minor !== ts.subtotal || row.tax_minor !== ts.tax) {
              mismatches.push(`#${i}: SQL ${row.subtotal_minor}+${row.tax_minor}, TS ${ts.subtotal}+${ts.tax}`);
            }
            // The same lines taxed per line instead of per rate: if the data never told the two rules apart,
            // agreement above would prove little.
            const perLine = ts.lineAmounts.reduce((sum, amount, j) => sum + (2n * amount * lines[j]!.taxRate + 100_000n) / 200_000n, 0n);
            if (perLine !== row.tax_minor) perLineDiffers++;
          }
          throw new Error("rolled back");
        },
        app,
      ),
    ).rejects.toThrow(/rolled back/);
    expect(mismatches).toEqual([]);
    expect(perLineDiffers).toBeGreaterThan(50);
  }, 60_000);
});
