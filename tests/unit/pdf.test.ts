// The PDF writer (src/server/invoices/pdf.ts): a well-formed file (every xref offset points at its object),
// deterministic bytes, the invoice's facts and exact amounts in the text, page breaks that lose no line,
// and text encoded the way WinAnsiEncoding needs. tests/fixtures/invoice.ts builds the invoices.
import { describe, expect, it } from "vitest";
import { pdfString, renderInvoicePdf, textWidth, wrap } from "@/server/invoices/pdf";
import { sampleInvoice } from "../fixtures/invoice";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

/** Checks the cross-reference table against the file; returns the object count and the page count. */
function structure(pdf: string): { objects: number; pages: number } {
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  expect(pdf.slice(startxref, startxref + 5)).toBe("xref\n");
  const count = Number(/^xref\n0 (\d+)\n/.exec(pdf.slice(startxref))![1]);
  const entries = pdf.slice(startxref).split("\n").slice(2, 2 + count);
  expect(entries[0]).toBe("0000000000 65535 f ");
  entries.slice(1).forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10));
    expect(entry.slice(10)).toBe(" 00000 n ");
    expect(pdf.slice(offset, offset + `${i + 1} 0 obj\n`.length)).toBe(`${i + 1} 0 obj\n`);
  });
  expect(pdf).toContain(`trailer\n<< /Size ${count} /Root 1 0 R`);
  // Each stream's /Length is its exact byte count.
  for (const match of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = match.index + match[0].length;
    expect(pdf.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe("\nendstream");
  }
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(pdf)![1]);
  return { objects: count, pages };
}

/** The strings drawn with Tj, in order, decoded from WinAnsi (enough for these tests). */
function shown(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
}

describe("renderInvoicePdf", () => {
  it("writes a well-formed one-page PDF with the invoice's facts and exact amounts", () => {
    const pdf = text(renderInvoicePdf({ organizationName: "Cobol & Co.", invoice: sampleInvoice() }));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(structure(pdf).pages).toBe(1);
    const strings = shown(pdf);
    for (const expected of ["Cobol & Co.", "INVOICE", "INV-0042", "Open", "Nov 12, 2026", "Dec 12, 2026", "Navy Yard (Payables)", "1 Dock St"]) {
      expect(strings).toContain(expected);
    }
    // 1.5 x $3.33 = $4.995 → $5.00; tax per rate; total $53.42 (the e2e test's invoice too).
    for (const amount of ["$5.00", "$39.98", "$44.98", "Tax 8.875% on $5.00", "$0.44", "Tax 20% on $39.98", "$8.00", "$53.42"]) {
      expect(strings).toContain(amount);
    }
    expect(pdf).toContain("/Title (INV-0042)");
  });

  it("is deterministic: the same invoice gives the same bytes", () => {
    const a = renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice() });
    const b = renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice() });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("marks a draft as a draft on every page", () => {
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice({ status: "DRAFT" }) }));
    const strings = shown(pdf);
    expect(strings).toContain("DRAFT INVOICE");
    expect(strings.filter((s) => s.startsWith("Draft: not a final invoice"))).toHaveLength(structure(pdf).pages);
    expect(strings).not.toContain("INV-0042");
  });

  it("breaks 100 lines over pages without losing or repeating one, and numbers the pages", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      description: i % 5 === 0 ? `Item ${i + 1} with a description long enough to wrap onto a second line of the column` : `Item ${i + 1}`,
      quantity: 1000n,
      unitPriceMinor: BigInt(i + 1),
      taxRate: 0n,
    }));
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice({ lines, memo: null }) }));
    const { pages } = structure(pdf);
    expect(pages).toBeGreaterThan(2);
    const strings = shown(pdf);
    for (let i = 1; i <= 100; i++) {
      expect(strings.filter((s) => s === `Item ${i}` || s.startsWith(`Item ${i} `))).toHaveLength(1);
    }
    for (let p = 1; p <= pages; p++) expect(strings).toContain(`INV-0042 · page ${p} of ${pages}`);
    // The table header is repeated on every page; the totals come once, after the last line.
    expect(strings.filter((s) => s === "Description")).toHaveLength(pages);
    expect(strings.filter((s) => s === "Total")).toHaveLength(1);
    expect(strings.indexOf("Total")).toBeGreaterThan(strings.indexOf("Item 100"));
  });

  it("keeps every drawn line inside the page's margins", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ description: `Item ${i}`, quantity: 1000n, unitPriceMinor: 1n, taxRate: 0n }));
    const pdf = text(renderInvoicePdf({ organizationName: "A", invoice: sampleInvoice({ lines }) }));
    for (const m of pdf.matchAll(/\/F\d (\d+) Tf [\d.]+ g ([\d.]+) ([\d.]+) Td/g)) {
      const [x, y] = [Number(m[2]), Number(m[3])];
      expect(x).toBeGreaterThanOrEqual(50);
      expect(y).toBeGreaterThanOrEqual(39); // the footer line sits 10 pt below the bottom margin
      expect(y).toBeLessThanOrEqual(742);
    }
  });
});

describe("text encoding", () => {
  it("escapes the three characters PDF strings reserve", () => {
    expect(pdfString("a (b) \\c")).toBe("(a \\(b\\) \\\\c)");
  });

  it("writes Windows-1252 bytes, and ? for characters it can't encode", () => {
    expect(pdfString("Zoë")).toBe("(Zo\xeb)");
    expect(pdfString("€5 — “ok”")).toBe("(\x805 \x97 \x93ok\x94)");
    expect(pdfString("東京")).toBe("(??)");
    // Composed first: e + combining acute is one é.
    expect(pdfString("é")).toBe("(\xe9)");
    // An emoji is one character (two UTF-16 units), so one ?.
    expect(pdfString("🙂")).toBe("(?)");
  });

  it("measures with Helvetica's metrics, bold wider than regular", () => {
    expect(textWidth("0123456789", 10)).toBeCloseTo(55.6);
    expect(textWidth("Amount", 9, "F2")).toBeGreaterThan(textWidth("Amount", 9));
    expect(textWidth("$1,234.56", 10, "F2")).toBeCloseTo(textWidth("$1,234.56", 10));
  });

  it("wraps at spaces, keeps explicit line breaks, and cuts a word too long for the line", () => {
    expect(wrap("one two three", 10, textWidth("one two", 10))).toEqual(["one two", "three"]);
    expect(wrap("a\nb", 10, 100)).toEqual(["a", "b"]);
    const cut = wrap("x".repeat(100), 10, 50);
    expect(cut.join("")).toBe("x".repeat(100));
    for (const piece of cut) expect(textWidth(piece, 10)).toBeLessThanOrEqual(50);
  });
});
