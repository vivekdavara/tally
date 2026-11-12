// WHAT'S WRONG: the bill-to name cap of 9 lines (src/server/invoices/pdf.ts:274) was sized as "a 200-character
// name in bold" of its widest character run together (200 x "Æ" = 23 per 260-pt line = 9 lines). But wrap()
// breaks at spaces, so words that don't pair up on a line waste most of each line: 15 words of 12 "Æ" (132 pt
// each; two plus a space = 267 pt > 260) are 194 characters, which customerInput accepts (line("a name", 200)
// refuses only control and bidi characters), and wrap to 15 lines. clip() keeps 9 and ends the 9th in "…": the
// claim in the comment at pdf.ts:268-270 ("nothing the forms accept is ever cut") is false. Plain ASCII does it
// too (e.g. words of 13 "W", bold 944/1000).
// WHY IT MATTERS: round 3's whole point was that what the form accepts prints in full on the invoice; a valid
// customer's name is silently truncated on an issued invoice instead.
// FIX: bound the name the way the address now is -- refine customerInput.name with
// wrap(value, 11, BILL_TO_WIDTH, "F2").length <= a cap exported from pdf.ts (and use that same constant in the
// clip call), rather than deriving the cap from a no-spaces worst case that ignores word-break waste.
import { describe, expect, it } from "vitest";
import { BILL_TO_WIDTH, renderInvoicePdf, wrap } from "@/server/invoices/pdf";
import { customerInput } from "@/server/invoices/schemas";
import { sampleInvoice } from "../fixtures/invoice";

const tooLong = Array.from({ length: 15 }, () => "Æ".repeat(12)).join(" "); // 194 characters
// (Adapted after the fix, the reviewer's suggested one: the form now refuses a name that wraps past the 9 lines
// the PDF prints, so this 15-line name is refused, and the remaining tests check the longest name of the same
// shape that the form still accepts.)
const accepts = (n: string) => customerInput.safeParse({ name: n, email: "a@example.com", address: "" }).success;
let name = tooLong;
while (!accepts(name)) name = name.split(" ").slice(0, -1).join(" ");

describe("a valid customer name in the bill-to block", () => {
  it("is refused by the customer form when it wouldn't print in full", () => {
    expect(tooLong.length).toBeLessThanOrEqual(200);
    expect(accepts(tooLong)).toBe(false);
    expect(name.split(" ").length).toBeGreaterThan(5);
  });

  it("wraps to no more lines than the PDF prints (9)", () => {
    expect(wrap(name, 11, BILL_TO_WIDTH, "F2").length).toBeLessThanOrEqual(9); // fails: 15
  });

  it("is printed in full, with no ellipsis", () => {
    const invoice = sampleInvoice();
    invoice.customer = { ...invoice.customer, name };
    const pdf = Buffer.from(renderInvoicePdf({ organizationName: "Wide Ltd", invoice })).toString("latin1");
    // Count the 11-pt bold (name) placements, and look for the ellipsis (0x85 in WinAnsi) in them.
    // (Adapted: only the bill-to column at x = 50; the Total row is 11 pt bold too.)
    const nameRuns = [...pdf.matchAll(/\/F2 11 Tf [\d.]+ g 50\.00 [\d.]+ Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]!);
    expect(nameRuns.some((run) => run.includes("\x85"))).toBe(false); // fails: the 9th line ends in "…"
    expect(nameRuns.length).toBe(wrap(name, 11, BILL_TO_WIDTH, "F2").length);
    expect(nameRuns.join(" ")).toBe(name);
  });
});
