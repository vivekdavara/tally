// WHAT'S WRONG: src/server/invoices/pdf.ts draws some blocks without checking they fit:
//  1. the totals block asks need(totals.length * 18 + 10) once and then draws every row; with many tax rates
//     (each of up to 100 lines may have its own rate, so up to 102 rows ≈ 1,846 pt) a fresh page can't hold it
//     and the rows keep going below the bottom of the page (negative y) -- the Total row is never visible;
//  2. the "Bill to" block (customer address: up to 500 characters, line breaks allowed) is drawn with no need()
//     at all, so a 60-line address runs off the bottom of page 1, and the table header is drawn below the page;
//  4. columns overlap for amounts the inputs allow: a line of 1,000,000 x $100,000,000.00 (both at their
//     limits) prints its amount "$100,000,000,000,000.00" starting left of the Tax column's right edge (485 pt),
//     on top of the tax rate, and the Total value runs over the "Total" label;
//  3. the customer name (up to 200 characters, 11 pt bold) and the organization name aren't wrapped or
//     truncated, so a long one runs past the right edge of the page (and over the facts column).
// The existing "keeps every drawn line inside the page's margins" test in tests/unit/pdf.test.ts can't catch
// (1) or (2): its regex `([\d.]+) ([\d.]+) Td` doesn't match a negative coordinate, so off-page text is skipped.
// WHY IT MATTERS: an issued invoice whose PDF hides its total or its customer's address is a wrong document.
// SUGGESTED FIX: call need() per totals row (and per Bill-to line, starting a "plain" page), wrap or truncate
// the names to the space they have, and size the columns
// (or shrink the font) for the widest amount the limits allow; in the test, match -?[\d.]+ coordinates.
import { describe, expect, it } from "vitest";
import { renderInvoicePdf, textWidth } from "@/server/invoices/pdf";
import { sampleInvoice } from "../fixtures/invoice";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Every text placement: font, size, x, y and the (unescaped) string. Negative coordinates included. */
function placements(pdf: string) {
  return [...pdf.matchAll(/\/(F\d) (\d+) Tf [\d.]+ g (-?[\d.]+) (-?[\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => ({
    font: m[1] as "F1" | "F2",
    size: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
    s: m[5]!.replace(/\\(.)/g, "$1"),
  }));
}

describe("PDF text stays on the page", () => {
  it("100 lines with 100 different tax rates: every totals row, and the Total, is on a page", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ description: `Item ${i}`, quantity: 1000n, unitPriceMinor: 100n, taxRate: BigInt(i + 1) * 100n }));
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice({ lines, memo: null }) }));
    const offPage = placements(pdf).filter((p) => p.y < 39);
    expect(offPage.map((p) => `${p.s}@${p.y}`).slice(0, 5)).toEqual([]);
  });

  it("a 60-line address keeps the Bill to block and the table header on the page", () => {
    const base = sampleInvoice();
    const invoice = { ...base, customer: { ...base.customer, address: Array.from({ length: 60 }, (_, i) => `L${i}`).join("\n") } };
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice }));
    const offPage = placements(pdf).filter((p) => p.y < 39);
    expect(offPage.map((p) => `${p.s}@${p.y}`).slice(0, 5)).toEqual([]);
  });

  it("a 200-character customer name doesn't run past the right edge", () => {
    const base = sampleInvoice();
    const invoice = { ...base, customer: { ...base.customer, name: "Wide ".repeat(40).trim() } };
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice }));
    const tooWide = placements(pdf).filter((p) => p.x + textWidth(p.s, p.size, p.font) > 612 - 50 + 0.01);
    expect(tooWide.map((p) => `${p.s.slice(0, 20)}… right edge ${(p.x + textWidth(p.s, p.size, p.font)).toFixed(0)}`)).toEqual([]);
  });

  it("the largest line amount the limits allow doesn't overlap the Tax column, nor the Total its label", () => {
    const lines = [{ description: "Max", quantity: 1_000_000_000n, unitPriceMinor: 10_000_000_000n, taxRate: 8875n }];
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice({ lines, memo: null }) }));
    const all = placements(pdf);
    const amount = all.find((p) => p.s === "$100,000,000,000,000.00" && p.size === 10)!;
    expect(amount).toBeDefined();
    // The tax column's text must end before the amount starts. (Adapted after the fix: the reviewer compared with
    // the fixed column edge 485; the columns are now sized to their widest cell, so this measures the line's tax
    // cell itself, which is the overlap the finding is about.)
    const taxCell = all.find((p) => p.y === amount.y && p.s === "8.875%")!;
    expect(amount.x).toBeGreaterThanOrEqual(taxCell.x + textWidth(taxCell.s, taxCell.size, taxCell.font));
    const total = all.find((p) => p.s === "Total")!;
    const totalValue = all.find((p) => p.y === total.y && p.s.startsWith("$"))!;
    expect(totalValue.x).toBeGreaterThanOrEqual(total.x + textWidth("Total", 11, "F2"));
  });
});
