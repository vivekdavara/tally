// WHAT'S WRONG: the organization name is still clipped to 2 lines of 18-pt bold in the letterhead
// (src/server/invoices/pdf.ts:247), about 352-418 pt wide beside the title, while signUpInput accepts up to 100
// characters (src/server/auth/schemas.ts:31-37, name()). An ordinary 100-character organization name in plain
// English wraps to 3 lines and is printed with "…" -- on every invoice the organization issues. Round 3's commit
// ("what the forms accept, the PDF prints in full") raised the bill-to caps to match what the forms accept but
// left this one (pre-existing, not introduced by round 3; the continuation header's 1-line clip at pdf.ts:233 is
// the same kind of cut).
// WHY IT MATTERS: the issuer's own legal name is truncated on its invoices; no error is shown at sign-up.
// FIX: either refuse at sign-up an organization name that wraps to more than 2 lines at 18 pt bold in the
// narrower (DRAFT INVOICE) width -- the same refine pattern as the address, with the width exported from pdf.ts
// or raise the cap to what 100 characters can wrap to and check the page-1 budget still holds.
import { describe, expect, it } from "vitest";
import { fitsLetterhead, renderInvoicePdf, textWidth, wrap } from "@/server/invoices/pdf";
import { signUpInput } from "@/server/auth/schemas";
import { sampleInvoice } from "../fixtures/invoice";

const organizationName = "Northern California Association of Independent Landscape Architects and Garden Designers, Inc.";

describe("a valid organization name in the letterhead", () => {
  it("is accepted at sign-up", () => {
    expect(organizationName.length).toBeLessThanOrEqual(100);
    const parsed = signUpInput.safeParse({
      name: "Ana",
      email: "ana@example.com",
      password: "correct horse battery",
      organizationName,
    });
    expect(parsed.success).toBe(true);
  });

  // (Adapted after the fix: the letterhead now sets a name that needs more than two lines at 18 pt in up to four
  // lines at 12 pt, and sign-up refuses only a name that wouldn't fit even then; the reviewer checked 18 pt only.)
  it("fits the letterhead (two lines at 18 pt, or four at 12 pt)", () => {
    const nameWidth = 612 - 100 - textWidth("DRAFT INVOICE", 18, "F2") - 20;
    expect(wrap(organizationName, 18, nameWidth, "F2").length <= 2 || wrap(organizationName, 12, nameWidth, "F2").length <= 4).toBe(true);
    expect(fitsLetterhead(organizationName)).toBe(true);
  });

  it("is printed in full, with no ellipsis", () => {
    const pdf = Buffer.from(renderInvoicePdf({ organizationName, invoice: sampleInvoice() })).toString("latin1");
    const runs = [...pdf.matchAll(/\/F2 (?:18|12) Tf [\d.]+ g [\d.]+ ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)]
      .filter((m) => Number(m[1]) > 700 && m[2] !== "INVOICE")
      .map((m) => m[2]!);
    expect(runs.some((run) => run.includes("\x85"))).toBe(false); // fails: the 2nd line ends in "…"
    expect(runs.join(" ")).toBe(organizationName);
  });
});
