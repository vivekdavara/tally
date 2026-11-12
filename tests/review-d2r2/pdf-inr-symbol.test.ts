// WHAT'S WRONG: INR is a supported currency (money.ts CURRENCIES), and formatMoney() renders it with the rupee
// sign ₹ (U+20B9), which isn't in Windows-1252, so pdfString() prints it as "?". Every amount on every INR
// invoice PDF reads "?1,234.56" (unit prices, line amounts, the tax bases, the Total). The documented limitation
// ("characters outside Windows-1252 print as ?", README/DESIGN) is about text users type in other scripts;
// here the application itself produces the unprintable character for one of its own currencies.
// WHY IT MATTERS: an issued INR invoice's total is printed as "?..." -- the currency of the amount due is
// replaced by a question mark.
// SUGGESTED FIX: for the PDF, format with currencyDisplay: "code" (or "narrowSymbol" falling back to the code)
// whenever the symbol isn't WinAnsi-encodable -- "INR 1,234.56"; test every supported currency's formatted
// amount through pdfString for "?".
import { describe, expect, it } from "vitest";
import { pdfMoney, pdfString, renderInvoicePdf } from "@/server/invoices/pdf";
import { CURRENCIES, type Currency } from "@/server/invoices/money";
import { sampleInvoice } from "../fixtures/invoice";

describe("every supported currency's amounts print without a '?'", () => {
  for (const currency of Object.keys(CURRENCIES) as Currency[]) {
    it(`${currency}: the Total amount is encodable`, () => {
      const invoice = sampleInvoice({ currency });
      // (Adapted after the fix: the PDF formats with pdfMoney, which falls back to the ISO code when the symbol
      // isn't in Windows-1252; the web page keeps formatMoney's symbol.)
      const total = pdfMoney(invoice.totals.total, currency);
      expect(pdfString(total)).not.toContain("?");
      const pdf = Buffer.from(renderInvoicePdf({ organizationName: "Mumbai Traders", invoice })).toString("latin1");
      expect(pdf).toContain(pdfString(total));
    });
  }
});
