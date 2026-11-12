// WHAT'S WRONG: src/server/invoices/pdf.ts (renderInvoicePdf, the line-item loop) asks
// need(description.length * 13 + 5, "table") once per line item and then draws every wrapped line of the
// description. need() can only start a new page; when one description wraps into more lines than a whole page
// holds (about 47 below a continuation page's header), the rest are drawn below the page's bottom margin, into
// the footer ("page 1 of 2"), and below y = 0, off the page. The schema allows it: a description is up to 500
// characters (one line, schemas.ts), and with the columns sized for the largest amounts the limits allow
// (round 1's fix: each column as wide as its widest cell) the description column shrinks to ~100 pt in KWD/CHF,
// ~145 pt in USD. Words just over half that width wrap one per line: 500 characters become 70-80 lines.
// (Round 1's fix put a per-row check on the totals and the memo, not inside a line item.)
// WHY IT MATTERS: part of a line's description is missing from the issued invoice, and what is drawn overprints
// the footer.
// SUGGESTED FIX: draw a description line by line with need(13, "table") before each continuation line (a line
// item may split across pages, as the memo does), or clip the description to what one page holds; and/or give
// the description column a minimum width (shrinking the amount font instead).
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "@/server/invoices/pdf";
import type { Currency } from "@/server/invoices/money";
import { sampleInvoice } from "../fixtures/invoice";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Every text placement: font, size, x, y and the (escaped) string. Negative coordinates included. */
function placements(pdf: string) {
  return [...pdf.matchAll(/\/(F\d) (\d+) Tf [\d.]+ g (-?[\d.]+) (-?[\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => ({
    size: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
    s: m[5]!.replace(/\\(.)/g, "$1"),
  }));
}

// One line item at its limits, plus 99 more, so the amount columns are as wide as the limits allow.
function invoiceWith(description: string, currency: Currency) {
  const big = Array.from({ length: 99 }, (_, i) => ({ description: `Max ${i}`, quantity: 999_999_999n, unitPriceMinor: 10_000_000_000n, taxRate: 99_999n }));
  const lines = [{ description, quantity: 999_999_999n, unitPriceMinor: 9_999_999_999n, taxRate: 99_999n }, ...big];
  return sampleInvoice({ lines, memo: null, currency });
}

describe("one line item's description is taller than a page", () => {
  for (const [currency, word] of [
    ["KWD", "@@@@@"],
    ["USD", "@@@@@@@@"],
  ] as const) {
    it(`${currency}: a 500-character description (words of ${word.length}) stays above the footer`, () => {
      const description = Array.from({ length: Math.floor(500 / (word.length + 1)) }, () => word).join(" ");
      expect(description.length).toBeLessThanOrEqual(500);
      const all = placements(text(renderInvoicePdf({ organizationName: "Wide Columns Ltd", invoice: invoiceWith(description, currency) })));
      const drawn = all.filter((p) => p.s === word);
      // Every word of the description is drawn somewhere...
      expect(drawn.length).toBe(description.split(" ").length);
      // ...and none of them below the bottom margin the layout reserves for the footer (MARGIN + 30 = 80;
      // the footer itself is at y = 40, and y < 0 is off the page).
      const low = drawn.filter((p) => p.y < 80);
      expect(low.map((p) => p.y).slice(0, 8)).toEqual([]);
    });
  }
});
