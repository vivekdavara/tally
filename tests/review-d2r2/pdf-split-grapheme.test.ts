// WHAT'S WRONG: wrap() (src/server/invoices/pdf.ts) breaks a too-long word "between code points", but measures
// and cuts the text as given, while pdfString() prints it NFC-normalized. Text typed or pasted in decomposed form
// (macOS file names, some keyboards and copy sources give "e" + U+0301 COMBINING ACUTE ACCENT) can be cut
// between a letter and its combining mark: the first line ends with a bare "e" and the next starts with a lone
// U+0301, which isn't in Windows-1252 and prints as "?". (textWidth also counts the mark as a 556-wide glyph,
// so such text is measured almost twice as wide as it prints.) Nothing upstream normalizes: the line/multiline
// schemas (schemas.ts) keep the input as typed.
// WHY IT MATTERS: a "?" appears in the middle of a customer's or item's name on the issued invoice, and the
// accent is lost from the letter before it.
// SUGGESTED FIX: normalize to NFC once at the start of wrap()/clip()/textWidth (or in the input schemas), and
// break between grapheme clusters (Intl.Segmenter) rather than code points.
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "@/server/invoices/pdf";
import { sampleInvoice } from "../fixtures/invoice";

describe("a long decomposed word wrapped across lines", () => {
  it("prints no '?' for an accent that is in Windows-1252", () => {
    const description = "é".repeat(60); // "ééé...": every é is in Windows-1252 (0xE9)
    const lines = [{ description, quantity: 1000n, unitPriceMinor: 100n, taxRate: 0n }];
    const pdf = Buffer.from(renderInvoicePdf({ organizationName: "Café Ltd", invoice: sampleInvoice({ lines, memo: null }) })).toString("latin1");
    const drawn = [...pdf.matchAll(/50\.00 (-?[\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[2]!).filter((s) => s.includes("\xe9"));
    expect(drawn.length).toBeGreaterThan(1); // it wrapped
    expect(drawn.filter((s) => s.includes("?"))).toEqual([]);
  });
});
