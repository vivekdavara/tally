// WHAT'S WRONG: src/server/invoices/pdf.ts textWidth() measures every non-ASCII character not in OTHER_WIDTHS at
// 556 (a digit's width). Many WinAnsi characters that pdfString() prints are much wider in Helvetica (Adobe's
// AFM metrics, both weights): the capitals Ö Ø Ò-Õ 778, Ç Ð Ñ Ù-Ü 722; © ® 737; ¼ ½ ¾ 834; ™ ‰ 1000.
// Everything round 1's fix relies on -- wrap(), clip(), right-alignment, the column widths -- uses textWidth, so
// text with these characters is drawn wider than the box it was fitted to: an organization name in capitals
// with umlauts runs over the "INVOICE" title and past the right edge of the page (tested), a description with
// ™ or ® runs over the Qty column (tested); the Bill-to name/address and the memo are wrapped the same way.
// WHY IT MATTERS: overlapping or cut-off text on an issued invoice (German, Scandinavian, French, Spanish names;
// product names with ™/®) -- the failure round 1 fixed for ASCII.
// SUGGESTED FIX: give textWidth the full WinAnsi width table for both fonts (Helvetica.afm and
// Helvetica-Bold.afm list all 0x80-0xFF glyphs), keyed by code point after NFC (pdfString normalizes; textWidth
// doesn't), and test it against every byte pdfString can emit.
import { describe, expect, it } from "vitest";
import { renderInvoicePdf, textWidth } from "@/server/invoices/pdf";
import { sampleInvoice } from "../fixtures/invoice";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

// Helvetica.afm / Helvetica-Bold.afm advance widths (same in both) for the WinAnsi bytes used below.
const AFM: Record<number, number> = { 0xd6: 778, 0xdc: 722, 0x99: 1000, 0xae: 737 };
/** The width a PDF viewer draws a WinAnsi-encoded string with (ASCII from pdf.ts's own, correct, tables). */
const drawnWidth = (s: string, size: number, font: "F1" | "F2") =>
  [...s].reduce((sum, c) => sum + (AFM[c.charCodeAt(0)] !== undefined ? (AFM[c.charCodeAt(0)]! * size) / 1000 : textWidth(c, size, font)), 0);

function placements(pdf: string) {
  return [...pdf.matchAll(/\/(F\d) (\d+) Tf [\d.]+ g (-?[\d.]+) (-?[\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => {
    const font = m[1] as "F1" | "F2";
    const size = Number(m[2]);
    const x = Number(m[3]);
    const s = m[5]!.replace(/\\(.)/g, "$1");
    return { font, size, x, y: Number(m[4]), s, right: x + drawnWidth(s, size, font) };
  });
}

describe("text with wide Latin-1 letters is measured as if it were digits", () => {
  it("textWidth agrees with Helvetica's metrics for Ö, Ü, ™ and ®", () => {
    expect([textWidth("Ö", 1000), textWidth("Ü", 1000), textWidth("™", 1000), textWidth("®", 1000)]).toEqual([778, 722, 1000, 737]);
  });

  it("an organization name in capitals with umlauts stays clear of the title and inside the page", () => {
    // 100 characters is the limit (auth/schemas.ts); this is 83.
    const organizationName = "ÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜ ÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖÜÖ";
    const all = placements(text(renderInvoicePdf({ organizationName, invoice: sampleInvoice() })));
    const title = all.find((p) => p.s === "INVOICE" && p.size === 18)!;
    const nameLines = all.filter((p) => p.size === 18 && p.font === "F2" && p !== title);
    expect(nameLines.length).toBeGreaterThan(0);
    const overlapping = nameLines.filter((p) => p.right > title.x || p.right > 612 - 50);
    expect(overlapping.map((p) => `name line ends at ${p.right.toFixed(0)} pt; title starts at ${title.x.toFixed(0)}, page margin 562`)).toEqual([]);
  });

  it("a description with ™ and ® doesn't run over the Qty column", () => {
    const description = "Widget™ Pro® licence ™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™™ ®®®®®®®®®®®®®®®®®®®®®®®®®®®®®®";
    const lines = [{ description, quantity: 1000n, unitPriceMinor: 100n, taxRate: 0n }];
    const all = placements(text(renderInvoicePdf({ organizationName: "Acme Widgets", invoice: sampleInvoice({ lines, memo: null }) })));
    const qtyHeader = all.find((p) => p.s === "Qty")!;
    const qtyCell = all.find((p) => p.s === "1" && p.size === 10)!;
    const descriptionLines = all.filter((p) => p.x === 50 && p.size === 10 && (p.s.includes("\x99") || p.s.includes("\xae")));
    expect(descriptionLines.length).toBeGreaterThan(0);
    const left = Math.min(qtyHeader.x, qtyCell.x);
    const over = descriptionLines.filter((p) => p.right > left);
    expect(over.map((p) => `description line ends at ${p.right.toFixed(0)} pt; the Qty column starts at ${left.toFixed(0)}`)).toEqual([]);
  });
});
