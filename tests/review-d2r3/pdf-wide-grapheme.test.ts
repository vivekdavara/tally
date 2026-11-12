// WHAT'S WRONG: wrap() (src/server/invoices/pdf.ts:120-143) now breaks an over-long word only between grapheme
// clusters (review round 2), but a grapheme cluster has no size limit: a base letter followed by any number of
// combining marks (U+0300..U+036F, "Zalgo" text) is ONE cluster. Each mark after the first has no NFC composite,
// isn't in Windows-1252, and is printed by pdfString as "?" (556/1000 em each) -- textWidth measures it that way
// too -- so a single cluster can be hundreds of points wide, and the `rest.length > 1` loop can't split it. The
// line comes back wider than `width`, breaking wrap()'s own contract ("lines no wider than `width`"). Round 1's
// split between code points did break such a run. Nothing upstream stops it: line()/multiline() in schemas.ts
// refuse only Cc and bidi controls, so a 60-character description or a customer name passes validation.
// WHY IT MATTERS: the description is drawn straight across the Qty / Unit price / Tax / Amount columns (and, for a
// customer name in the bill-to block, which clip() leaves alone when it is one line, past the right edge of the
// page): the amounts on an issued invoice are overprinted.
// SUGGESTED FIX: in wrap(), when a single grapheme is itself wider than `width`, fall back to splitting it by code
// point (the marks print as "?" anyway), or refuse/limit combining marks per cluster in the input schemas (e.g.
// at most 2-3 \p{M} in a row) -- and test wrap() with a cluster wider than the column.
import { describe, expect, it } from "vitest";
import { renderInvoicePdf, textWidth, wrap } from "@/server/invoices/pdf";
import { customerInput, lineText } from "@/server/invoices/schemas";
import { sampleInvoice } from "../fixtures/invoice";

const zalgo = `a${"\u0301".repeat(60)}`; // one grapheme cluster, 61 code points

describe("a grapheme cluster wider than the column", () => {
  it("passes validation as a line description and as a customer name", () => {
    expect(lineText.safeParse({ description: `Work ${zalgo}`, quantity: "1", unitPrice: "1", taxRate: "0" }).success).toBe(true);
    expect(customerInput.safeParse({ name: `Acme ${zalgo}`, email: "a@example.com", address: "" }).success).toBe(true);
  });

  it("is still wrapped to lines no wider than the width", () => {
    const width = 200;
    const lines = wrap(`Work ${zalgo}`, 10, width);
    const tooWide = lines.filter((l) => textWidth(l, 10) > width).map((l) => textWidth(l, 10));
    expect(tooWide).toEqual([]); // fails: [~333.6] -- one line 1.7x the column
  });

  it("doesn't print a customer name past the right edge of the page", () => {
    const invoice = sampleInvoice();
    invoice.customer = { ...invoice.customer, name: `Acme ${"a" + "\u0301".repeat(150)}` };
    const pdf = Buffer.from(renderInvoicePdf({ organizationName: "Wide Ltd", invoice })).toString("latin1");
    // Every 11-pt bold (name) text placement: x + width of what it prints.
    const ends = [...pdf.matchAll(/\/F2 11 Tf [\d.]+ g ([\d.]+) [\d.]+ Td \(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((m) => Number(m[1]) + textWidth(m[2]!.replace(/\\(.)/g, "$1"), 11, "F2"));
    expect(ends.length).toBeGreaterThan(0);
    expect(Math.max(...ends)).toBeLessThanOrEqual(612); // fails: the name runs to ~1058 pt on a 612-pt page
  });
});
