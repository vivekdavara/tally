import { computeTotals, type Currency, type LineInput } from "@/server/invoices/money";
import type { InvoiceView } from "@/server/invoices/service";

/** An InvoiceView for rendering tests, built the way getInvoice builds one (totals from money.ts). */
export function sampleInvoice(options: { lines?: (LineInput & { description: string })[]; status?: InvoiceView["status"]; currency?: Currency; memo?: string | null } = {}): InvoiceView {
  const lines = options.lines ?? [
    { description: "Consulting (October)", quantity: 1500n, unitPriceMinor: 333n, taxRate: 8875n },
    { description: "Licences", quantity: 2000n, unitPriceMinor: 1999n, taxRate: 20000n },
  ];
  const totals = computeTotals(lines);
  const status = options.status ?? "OPEN";
  return {
    id: "00000000-0000-4000-8000-000000000001",
    number: status === "DRAFT" ? null : 42,
    status,
    currency: options.currency ?? "USD",
    memo: options.memo === undefined ? "Thank you for your business.\nPay by bank transfer within 30 days." : options.memo,
    issuedAt: status === "DRAFT" ? null : new Date("2026-11-12T15:30:00Z"),
    dueOn: status === "DRAFT" ? null : new Date("2026-12-12T00:00:00Z"),
    createdAt: new Date("2026-11-12T15:00:00Z"),
    customer: { id: "00000000-0000-4000-8000-000000000002", name: "Navy Yard (Payables)", email: "payables@navy.example", address: "1 Dock St\nWashington, DC 20374" },
    lines: lines.map((l, i) => ({ id: `line-${i}`, position: i + 1, ...l, amount: totals.lineAmounts[i]! })),
    totals,
  };
}
