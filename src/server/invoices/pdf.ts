import { formatDate, invoiceLabel, STATUS_LABELS } from "./format";
import { formatMoney, formatQuantity, formatTaxRate, type Currency } from "./money";
import type { InvoiceView } from "./service";

// Invoice PDFs, written directly (DESIGN.md, "PDFs"). An invoice needs text, a few rules and page breaks, which
// PDF's built-in Helvetica covers without embedding a font; writing the file by hand keeps it a dependency-free
// under 300 lines whose every byte a test can check. The output is deterministic (no timestamps or ids), so the same
// invoice always gives the same bytes. Limits: the standard fonts use WinAnsiEncoding, so characters outside
// Windows-1252 print as "?" (DESIGN.md says what embedding a font would take).

const PAGE = { width: 612, height: 792 }; // US Letter, in points
const MARGIN = 50;
const RIGHT = PAGE.width - MARGIN;
const GAP = 14; // between table columns
/** The bill-to block's width and how many address lines it prints (schemas.ts validates against the same). */
export const BILL_TO_WIDTH = 260;
export const BILL_TO_ADDRESS_LINES = 12;
export const BILL_TO_NAME_LINES = 9;

/**
 * The letterhead's room for the organization's name, beside the wider of the two titles: two lines at 18 pt,
 * or, for a name that needs more, four at 12 pt (review round 4: an ordinary 95-character name was cut).
 */
export const letterheadWidth = (): number => RIGHT - MARGIN - textWidth("DRAFT INVOICE", 18, "F2") - 20;
const LETTERHEAD_SIZES = [
  { size: 18, lines: 2, step: 22 },
  { size: 12, lines: 4, step: 15 },
] as const;

/** Whether an organization name prints in full in the letterhead (sign-up refuses one that wouldn't). */
export function fitsLetterhead(name: string): boolean {
  return wrap(name, 12, letterheadWidth(), "F2").length <= 4;
}

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

// Every other character Windows-1252 can encode, from the same AFM files (review round 2 of day 2: measuring them
// all as a digit put capitals with umlauts over the title and ™ over the Qty column). Accented letters take their
// base letter's width in Helvetica (À = A, é = e), so they are measured through NFD; these are the rest, as
// [regular, bold].
const OTHER_WIDTHS: Record<number, [number, number]> = {
  0xa0: [278, 278], 0xa1: [333, 333], 0xa2: [556, 556], 0xa3: [556, 556], 0xa4: [556, 556], 0xa5: [556, 556],
  0xa6: [260, 280], 0xa7: [556, 556], 0xa8: [333, 333], 0xa9: [737, 737], 0xaa: [370, 370], 0xab: [556, 556],
  0xac: [584, 584], 0xad: [333, 333], 0xae: [737, 737], 0xaf: [333, 333], 0xb0: [400, 400], 0xb1: [584, 584],
  0xb2: [333, 333], 0xb3: [333, 333], 0xb4: [333, 333], 0xb5: [556, 611], 0xb6: [537, 556], 0xb7: [278, 278],
  0xb8: [333, 333], 0xb9: [333, 333], 0xba: [365, 365], 0xbb: [556, 556], 0xbc: [834, 834], 0xbd: [834, 834],
  0xbe: [834, 834], 0xbf: [611, 611], 0xc6: [1000, 1000], 0xd0: [722, 722], 0xd7: [584, 584], 0xd8: [778, 778],
  0xde: [667, 667], 0xdf: [611, 611], 0xe6: [889, 889], 0xf0: [556, 611], 0xf7: [584, 584], 0xf8: [611, 611],
  // ì í î ï are built on the dotless i, wider than i (a pdfminer comparison caught them).
  0xec: [278, 278], 0xed: [278, 278], 0xee: [278, 278], 0xef: [278, 278],
  0xfe: [556, 611], 0x152: [1000, 1000], 0x153: [944, 944], 0x192: [556, 556], 0x2c6: [333, 333],
  0x2dc: [333, 333], 0x2013: [556, 556], 0x2014: [1000, 1000], 0x2018: [222, 278], 0x2019: [222, 278],
  0x201a: [222, 278], 0x201c: [333, 500], 0x201d: [333, 500], 0x201e: [333, 500], 0x2020: [556, 556],
  0x2021: [556, 556], 0x2022: [350, 350], 0x2026: [1000, 1000], 0x2030: [1000, 1000], 0x2039: [333, 333],
  0x203a: [333, 333], 0x20ac: [556, 556], 0x2122: [1000, 1000],
};

type Font = "F1" | "F2"; // Helvetica, Helvetica-Bold

/** One character's advance width in thousandths of the font size, as drawn (after WinAnsi encoding). */
function charWidth(char: string, font: Font): number {
  const widths = font === "F2" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const code = char.codePointAt(0)!;
  if (code >= 32 && code <= 126) return widths[code - 32]!;
  const other = OTHER_WIDTHS[code];
  if (other) return other[font === "F2" ? 1 : 0];
  // An accented Latin letter: its base letter's width.
  const base = char.normalize("NFD").codePointAt(0)!;
  if (base !== code && base >= 32 && base <= 126 && isWinAnsi(char)) return widths[base - 32]!;
  // Anything else is printed as "?".
  return widths["?".charCodeAt(0) - 32]!;
}

/** Width of `text` in points at `size` in `font`, as a viewer draws it. */
export function textWidth(text: string, size: number, font: Font = "F1"): number {
  let units = 0;
  for (const char of text.normalize("NFC")) units += charWidth(char, font);
  return (units * size) / 1000;
}

// Windows-1252's 0x80-0x9F block; 0xA0-0xFF is the same as Latin-1.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Whether WinAnsiEncoding (Windows-1252) has this character. */
export function isWinAnsi(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff) || CP1252_HIGH[code] !== undefined;
}

/**
 * An amount for the PDF: as on the page, unless the currency's symbol can't be encoded (₹ isn't in
 * Windows-1252, so every INR amount printed "?53.42": review round 2), then with the ISO code ("INR 53.42").
 */
export function pdfMoney(minor: bigint, currency: Currency): string {
  const shown = formatMoney(minor, currency);
  return [...shown].every(isWinAnsi) ? shown : formatMoney(minor, currency, "en-US", "code");
}

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

/**
 * Splits `text` into lines no wider than `width` points, breaking at spaces, or inside a word too long for a
 * line: between grapheme clusters of the NFC form, so neither a surrogate pair nor a letter and its combining
 * accent is ever split (review rounds 1 and 2).
 */
export function wrap(text: string, size: number, width: number, font: Font = "F1"): string[] {
  const lines: string[] = [];
  for (const paragraph of text.normalize("NFC").split("\n")) {
    let current = "";
    for (const word of paragraph.split(/ +/)) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (textWidth(candidate, size, font) <= width) {
        current = candidate;
        continue;
      }
      if (current !== "") lines.push(current);
      let rest = graphemes(word);
      while (textWidth(rest.join(""), size, font) > width) {
        // A single cluster wider than the line (a letter with dozens of combining marks is one cluster): only
        // then is it cut by code point (review round 3: one such name ran to x = 1058 on a 612 pt page).
        if (textWidth(rest[0]!, size, font) > width && Array.from(rest[0]!).length > 1) {
          rest = [...Array.from(rest[0]!), ...rest.slice(1)];
          continue;
        }
        if (rest.length === 1) break; // one code point wider than the line: nothing smaller to cut
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut).join(""), size, font) > width) cut--;
        lines.push(rest.slice(0, cut).join(""));
        rest = rest.slice(cut);
      }
      current = rest.join("");
    }
    lines.push(current);
  }
  return lines;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (s) => s.segment);

/** At most `max` of `lines`; if any were dropped, the last kept one ends in an ellipsis (still within `width`). */
export function clip(lines: string[], max: number, size: number, width: number, font: Font = "F1"): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = graphemes(kept[max - 1]!);
  while (last.length > 0 && textWidth(`${last.join("")}…`, size, font) > width) last = last.slice(0, -1);
  kept[max - 1] = `${last.join("")}…`;
  return kept;
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
  const money = (minor: bigint) => pdfMoney(minor, invoice.currency);
  const label = invoiceLabel(invoice.number);
  const draft = invoice.status === "DRAFT";
  const pages: Page[] = [];
  let page = new Page();
  let y = 0;

  // Columns, right to left, each as wide as its widest cell (and at least the usual width, so an ordinary invoice
  // always has the same layout): even the largest amounts the limits allow fit at full size without overlapping
  // the next column (review of day 2), and the description gets what's left.
  const cells = invoice.lines.map((l) => ({
    qty: formatQuantity(l.quantity),
    price: money(l.unitPriceMinor),
    tax: `${formatTaxRate(l.taxRate)}%`,
    amount: money(l.amount),
  }));
  const totals: { name: string; value: string; font: Font; size: number }[] = [
    { name: "Subtotal", value: money(invoice.totals.subtotal), font: "F1", size: 10 },
    ...invoice.totals.taxes.map((g) => ({ name: `Tax ${formatTaxRate(g.rate)}% on ${money(g.base)}`, value: money(g.tax), font: "F1" as Font, size: 10 })),
    { name: "Total", value: money(invoice.totals.total), font: "F2", size: 11 },
  ];
  const widest = (minimum: number, header: string, texts: string[], extra: number[] = []) =>
    Math.max(minimum, textWidth(header, 9, "F2"), ...texts.map((t) => textWidth(t, 10)), ...extra);
  const col = { amount: RIGHT, tax: 0, price: 0, qty: 0 };
  col.tax = col.amount - widest(63, "Amount", cells.map((c) => c.amount), totals.map((t) => textWidth(t.value, t.size, t.font))) - GAP;
  col.price = col.tax - widest(41, "Tax", cells.map((c) => c.tax)) - GAP;
  col.qty = col.price - widest(76, "Unit price", cells.map((c) => c.price)) - GAP;
  const descriptionWidth = col.qty - widest(46, "Qty", cells.map((c) => c.qty)) - GAP - MARGIN;

  const tableHeader = () => {
    page.text(MARGIN, y, "Description", 9, "F2");
    page.right(col.qty, y, "Qty", 9, "F2");
    page.right(col.price, y, "Unit price", 9, "F2");
    page.right(col.tax, y, "Tax", 9, "F2");
    page.right(col.amount, y, "Amount", 9, "F2");
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
      // The full name, on as many lines as it takes (at most 3 for a name sign-up accepts).
      for (const header of clip(wrap(`${organizationName} · ${label} (continued)`, 9, RIGHT - MARGIN), 3, 9, RIGHT - MARGIN)) {
        page.text(MARGIN, y, header, 9, "F1", 0.4);
        y -= 11;
      }
      y -= 13;
      if (kind === "table") tableHeader();
    }
  };
  /** Room for `height` points above the footer, or a new page. */
  const need = (height: number, kind: "table" | "plain") => {
    if (y - height < MARGIN + 30) newPage(kind);
  };

  // Letterhead: the organization's name wraps (two lines at most) beside the title.
  newPage("first");
  const title = draft ? "DRAFT INVOICE" : "INVOICE";
  page.right(RIGHT, y - 4, title, 18, "F2", draft ? 0.55 : 0);
  const nameWidth = letterheadWidth();
  const letterhead = LETTERHEAD_SIZES.find((f) => wrap(organizationName, f.size, nameWidth, "F2").length <= f.lines) ?? LETTERHEAD_SIZES[1];
  const nameLines = clip(wrap(organizationName, letterhead.size, nameWidth, "F2"), letterhead.lines, letterhead.size, nameWidth, "F2");
  for (const nameLine of nameLines) {
    page.text(MARGIN, y - 4, nameLine, letterhead.size, "F2");
    y -= letterhead.step;
  }
  y -= 12;
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
  // Bill to, in a column clear of the facts: every part wrapped to it, and capped so the block always fits on
  // the first page (an ellipsis marks a cut). The caps are what valid input can wrap to at worst (a 200-character
  // name in bold, a 254-character email of its widest character, an address the schema accepts), so nothing
  // the forms accept is ever cut; they only bound data that skipped validation.
  let billY = factsTop;
  page.text(MARGIN, billY, "Bill to", 9, "F1", 0.4);
  billY -= 14;
  for (const nameLine of clip(wrap(invoice.customer.name, 11, BILL_TO_WIDTH, "F2"), BILL_TO_NAME_LINES, 11, BILL_TO_WIDTH, "F2")) {
    page.text(MARGIN, billY, nameLine, 11, "F2");
    billY -= 14;
  }
  const contact = [
    ...clip(wrap(invoice.customer.email, 10, BILL_TO_WIDTH), 11, 10, BILL_TO_WIDTH),
    ...(invoice.customer.address
      ? clip(wrap(invoice.customer.address, 10, BILL_TO_WIDTH), BILL_TO_ADDRESS_LINES, 10, BILL_TO_WIDTH)
      : []),
  ];
  for (const contactLine of contact) {
    page.text(MARGIN, billY, contactLine, 10);
    billY -= 13;
  }
  y = Math.min(y, billY) - 20;
  tableHeader();

  invoice.lines.forEach((line, i) => {
    const description = wrap(line.description, 10, descriptionWidth);
    // Keep a line item together when it fits on a page; a description taller than a page (possible when the
    // columns leave it little width) continues on the next, one row at a time (review round 2).
    need(Math.min(description.length * 13 + 5, 13 * 8), "table");
    const cell = cells[i]!;
    page.text(MARGIN, y, description[0]!, 10);
    page.right(col.qty, y, cell.qty);
    page.right(col.price, y, cell.price);
    page.right(col.tax, y, cell.tax);
    page.right(col.amount, y, cell.amount);
    for (const more of description.slice(1)) {
      y -= 13;
      need(0, "table");
      page.text(MARGIN, y, more, 10);
    }
    y -= 18;
  });

  // One check per row: with up to 100 tax rates the block can be longer than a page.
  need(30, "plain");
  page.rule(y + 8, col.price - 60);
  for (const row of totals) {
    need(18, "plain");
    y -= 4;
    page.right(col.tax, y, row.name, row.size, row.font);
    page.right(col.amount, y, row.value, row.size, row.font);
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
