import { formatDate, invoiceLabel, STATUS_LABELS } from "./format";
import { formatMoney, formatQuantity, formatTaxRate } from "./money";
import type { InvoiceView } from "./service";

// Invoice PDFs, written directly (DESIGN.md, "PDFs"). An invoice needs text, a few rules and page breaks, which
// PDF's built-in Helvetica covers without embedding a font; writing the file by hand keeps it a dependency-free
// ~250 lines whose every byte a test can check. The output is deterministic (no timestamps or ids), so the same
// invoice always gives the same bytes. Limits: the standard fonts use WinAnsiEncoding, so characters outside
// Windows-1252 print as "?" (DESIGN.md says what embedding a font would take).

const PAGE = { width: 612, height: 792 }; // US Letter, in points
const MARGIN = 50;
const RIGHT = PAGE.width - MARGIN;
const COLUMNS = { qty: 340, price: 430, tax: 485, amount: RIGHT } as const; // right edges
const DESCRIPTION_WIDTH = 230;

// Helvetica's advance widths (thousandths of the font size) for ASCII 32-126, from its AFM file. Other
// characters use OTHER_WIDTHS, or 556 (a digit's width, close for the accented letters WinAnsi has).
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];

// Helvetica-Bold's, from its AFM file: digits and most punctuation match, letters are wider.
const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

// The non-ASCII characters this layout uses in right-aligned text, same in both weights (AFM): the no-break
// space Intl puts after a currency code, the middle dot in the footer, the currency symbols, dashes, ellipsis.
const OTHER_WIDTHS: Record<number, number> = {
  0xa0: 278, 0xb7: 278, 0x20ac: 556, 0xa3: 556, 0xa5: 556, 0x2013: 556, 0x2014: 1000, 0x2026: 1000,
};

type Font = "F1" | "F2"; // Helvetica, Helvetica-Bold

/** Width of `text` in points at `size` in `font`. */
export function textWidth(text: string, size: number, font: Font = "F1"): number {
  const widths = font === "F2" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? widths[code - 32]! : (OTHER_WIDTHS[code] ?? 556);
  }
  return (units * size) / 1000;
}

// Windows-1252's 0x80-0x9F block; 0xA0-0xFF is the same as Latin-1.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** `text` as a PDF literal string in WinAnsiEncoding: one byte per character, "?" for the unencodable. */
export function pdfString(text: string): string {
  let out = "(";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0)!;
    const byte = (code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff) ? code : (CP1252_HIGH[code] ?? 0x3f);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** Splits `text` into lines no wider than `width` points, breaking at spaces (or inside a too-long word). */
export function wrap(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let current = "";
    for (const word of paragraph.split(/ +/)) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (textWidth(candidate, size) <= width) {
        current = candidate;
        continue;
      }
      if (current !== "") lines.push(current);
      current = "";
      // A word wider than the line is cut into pieces that fit.
      let rest = word;
      while (textWidth(rest, size) > width) {
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut), size) > width) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      current = rest;
    }
    lines.push(current);
  }
  return lines;
}

/** A page's content stream under construction. */
class Page {
  ops: string[] = [];
  text(x: number, y: number, text: string, size = 10, font: Font = "F1", gray = 0): void {
    this.ops.push(`BT /${font} ${size} Tf ${gray} g ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfString(text)} Tj ET`);
  }
  right(xRight: number, y: number, text: string, size = 10, font: Font = "F1", gray = 0): void {
    this.text(xRight - textWidth(text, size, font), y, text, size, font, gray);
  }
  rule(y: number, x1 = MARGIN, x2 = RIGHT, width = 0.5): void {
    this.ops.push(`${width} w 0 G ${x1} ${y.toFixed(2)} m ${x2} ${y.toFixed(2)} l S`);
  }
}

export interface PdfInput {
  organizationName: string;
  invoice: InvoiceView;
}

/** The invoice as PDF bytes. */
export function renderInvoicePdf({ organizationName, invoice }: PdfInput): Uint8Array {
  const money = (minor: bigint) => formatMoney(minor, invoice.currency);
  const label = invoiceLabel(invoice.number);
  const draft = invoice.status === "DRAFT";
  const pages: Page[] = [];
  let page = new Page();
  let y = 0;

  const tableHeader = () => {
    page.text(MARGIN, y, "Description", 9, "F2");
    page.right(COLUMNS.qty, y, "Qty", 9, "F2");
    page.right(COLUMNS.price, y, "Unit price", 9, "F2");
    page.right(COLUMNS.tax, y, "Tax", 9, "F2");
    page.right(COLUMNS.amount, y, "Amount", 9, "F2");
    y -= 6;
    page.rule(y);
    y -= 14;
  };
  /** A new page: the first has the letterhead; later ones a "continued" line, and the table header if needed. */
  const newPage = (kind: "first" | "table" | "plain") => {
    page = new Page();
    pages.push(page);
    y = PAGE.height - MARGIN;
    if (kind !== "first") {
      page.text(MARGIN, y, `${organizationName} · ${label} (continued)`, 9, "F1", 0.4);
      y -= 24;
      if (kind === "table") tableHeader();
    }
  };
  /** Room for `height` points above the footer, or a new page. */
  const need = (height: number, kind: "table" | "plain") => {
    if (y - height < MARGIN + 30) newPage(kind);
  };

  newPage("first");
  page.text(MARGIN, y - 4, organizationName, 18, "F2");
  page.right(RIGHT, y - 4, draft ? "DRAFT INVOICE" : "INVOICE", 18, "F2", draft ? 0.55 : 0);
  y -= 34;
  const facts: [string, string][] = [
    ["Invoice", label],
    ["Status", STATUS_LABELS[invoice.status]],
    ...(invoice.issuedAt ? ([["Issued", formatDate(invoice.issuedAt)]] as [string, string][]) : []),
    ...(invoice.dueOn ? ([["Due", formatDate(invoice.dueOn)]] as [string, string][]) : []),
    ["Currency", invoice.currency],
  ];
  const factsTop = y;
  for (const [name, value] of facts) {
    page.right(RIGHT - 110, y, name, 9, "F1", 0.4);
    page.right(RIGHT, y, value, 10);
    y -= 14;
  }
  let billY = factsTop;
  page.text(MARGIN, billY, "Bill to", 9, "F1", 0.4);
  billY -= 14;
  page.text(MARGIN, billY, invoice.customer.name, 11, "F2");
  billY -= 14;
  for (const lineText of [invoice.customer.email, ...(invoice.customer.address ? wrap(invoice.customer.address, 10, 260) : [])]) {
    page.text(MARGIN, billY, lineText, 10);
    billY -= 13;
  }
  y = Math.min(y, billY) - 20;
  tableHeader();

  for (const line of invoice.lines) {
    const description = wrap(line.description, 10, DESCRIPTION_WIDTH);
    need(description.length * 13 + 5, "table");
    page.text(MARGIN, y, description[0]!, 10);
    page.right(COLUMNS.qty, y, formatQuantity(line.quantity));
    page.right(COLUMNS.price, y, money(line.unitPriceMinor));
    page.right(COLUMNS.tax, y, `${formatTaxRate(line.taxRate)}%`);
    page.right(COLUMNS.amount, y, money(line.amount));
    for (const more of description.slice(1)) {
      y -= 13;
      page.text(MARGIN, y, more, 10);
    }
    y -= 18;
  }

  const totals: [string, string, Font][] = [
    ["Subtotal", money(invoice.totals.subtotal), "F1"],
    ...invoice.totals.taxes.map((g): [string, string, Font] => [`Tax ${formatTaxRate(g.rate)}% on ${money(g.base)}`, money(g.tax), "F1"]),
    ["Total", money(invoice.totals.total), "F2"],
  ];
  need(totals.length * 18 + 10, "plain");
  page.rule(y + 8, COLUMNS.price - 60);
  for (const [name, value, font] of totals) {
    y -= 4;
    page.right(COLUMNS.tax, y, name, font === "F2" ? 11 : 10, font);
    page.right(COLUMNS.amount, y, value, font === "F2" ? 11 : 10, font);
    y -= 14;
  }
  if (invoice.memo) {
    y -= 16;
    const memo = wrap(invoice.memo, 10, RIGHT - MARGIN);
    need(14 + Math.min(memo.length, 4) * 13, "plain");
    page.text(MARGIN, y, "Notes", 9, "F1", 0.4);
    y -= 14;
    for (const memoLine of memo) {
      need(13, "plain");
      page.text(MARGIN, y, memoLine, 10);
      y -= 13;
    }
  }

  pages.forEach((p, i) => {
    p.right(RIGHT, MARGIN - 10, `${label} · page ${i + 1} of ${pages.length}`, 8, "F1", 0.4);
    if (draft) p.text(MARGIN, MARGIN - 10, "Draft: not a final invoice. The number and totals are assigned when it is finalized.", 8, "F1", 0.4);
  });
  return assemble(pages.map((p) => p.ops.join("\n")), label);
}

/**
 * The file: catalog, page tree, the two fonts, then a page and a content stream per page, an xref table
 * with each object's byte offset, and the trailer. Every byte is below 0x100 (latin1), so string length
 * equals byte length and the offsets are exact.
 */
function assemble(streams: string[], title: string): Uint8Array {
  const objects: string[] = [];
  const pageIds = streams.map((_, i) => 5 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${streams.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  streams.forEach((content, i) => {
    const pageId = pageIds[i]!;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  const infoId = objects.length;
  objects[infoId] = `<< /Title ${pdfString(title)} /Producer (Tally) >>`;

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(out, "latin1"));
}
