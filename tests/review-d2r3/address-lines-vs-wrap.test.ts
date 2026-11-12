// WHAT'S WRONG: customerInput.address (src/server/invoices/schemas.ts:47-48) allows "at most 6 lines" counted as
// "\n"-separated lines, with the comment "Six lines: what the PDF's bill-to block prints". But the PDF
// (src/server/invoices/pdf.ts:269) prints clip(wrap(address, 10, BILL_TO_WIDTH = 260), 6): wrapping a line wider
// than 260 pt (about 50 characters at 10 pt) makes more than one printed line, and clip() then drops everything
// after the sixth printed line. An address the form accepted -- 6 lines, 500-character limit, so ~83 characters
// a line on average -- loses its last lines (postcode, country) on the invoice, replaced by an ellipsis.
// WHY IT MATTERS: the limit was added so validation guarantees the whole address prints; it doesn't, and the
// truncation is silent (the customer page shows the full address, the issued PDF doesn't).
// SUGGESTED FIX: validate the way the PDF counts: wrap(address, 10, BILL_TO_WIDTH).length <= 6 (export the
// width and reuse wrap() in the schema's refine), or have the bill-to block print as many lines as validation
// allows.
import { describe, expect, it } from "vitest";
import { renderInvoicePdf } from "@/server/invoices/pdf";
import { customerInput } from "@/server/invoices/schemas";
import { sampleInvoice } from "../fixtures/invoice";

describe("a six-line address the form accepts", () => {
  it("prints in full on the invoice PDF", () => {
    const address = [
      "Accounts Payable, Unit 12, Building C, Riverside Business Park",
      "1234 Long Industrial Avenue",
      "Suite 500",
      "Springfield",
      "IL 62704",
      "United States of America",
    ].join("\n");
    const parsed = customerInput.safeParse({ name: "Acme Corp", email: "ap@acme.example", address });
    expect(parsed.success).toBe(true);

    const invoice = sampleInvoice();
    invoice.customer = { ...invoice.customer, address: parsed.data!.address };
    const pdf = Buffer.from(renderInvoicePdf({ organizationName: "Tally Ltd", invoice })).toString("latin1");
    // Fails: the first line wraps to two, so the sixth printed line is "IL 62704" and the country is cut.
    expect(pdf).toContain("(United States of America) Tj");
  });
});
