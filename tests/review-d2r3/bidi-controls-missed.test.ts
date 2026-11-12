// WHAT'S WRONG: round 2 refused bidirectional embeddings/overrides/isolates (U+202A-U+202E, U+2066-U+2069) in the
// invoice schemas (src/server/invoices/schemas.ts:22, used by line() and multiline()), but:
//  1. the organization name goes through a different schema, name() in src/server/auth/schemas.ts:24-29, which
//     only refuses \p{Cc}. That name is the issuer printed at the top of every invoice page (and the PDF
//     letterhead, the "continued" line), so U+202E RIGHT-TO-LEFT OVERRIDE is still accepted where it matters most.
//  2. the invisible bidi MARKS are not in the set: U+200F RIGHT-TO-LEFT MARK and U+061C ARABIC LETTER MARK are
//     strong right-to-left characters of zero width (the Trojan Source paper lists LRM/RLM/ALM with the others).
//     Between two of them, numbers and the spaces between them resolve right-to-left, so "<RLM>100 200<RLM>"
//     displays as "200 100": an amount in a description or memo can still read as something else.
// WHY IT MATTERS: the round-2 fix's stated purpose ("a name or an amount in a description read as something
// else") isn't met for the organization name, nor for the marks in any field.
// SUGGESTED FIX: share one refusal set (e.g. /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u) between
// auth/schemas.ts name() and invoices/schemas.ts line()/multiline().
import { describe, expect, it } from "vitest";
import { signUpInput } from "@/server/auth/schemas";
import { customerInput, lineText } from "@/server/invoices/schemas";

describe("bidirectional controls the round-2 refusal misses", () => {
  it("refuses an override in the organization name (sign-up)", () => {
    const result = signUpInput.safeParse({
      name: "Mallory",
      email: "m@example.com",
      password: "correct horse battery",
      organizationName: "Acme \u202eLLC 00.0001$\u202c",
    });
    expect(result.success).toBe(false); // fails: accepted
  });

  it("refuses a right-to-left mark in a description and a customer name", () => {
    const description = lineText.safeParse({ description: "Pay \u200f100 200\u200f", quantity: "1", unitPrice: "1", taxRate: "0" });
    const customer = customerInput.safeParse({ name: "Acme \u061c1 2\u061c", email: "a@example.com", address: "" });
    expect({ description: description.success, customer: customer.success }).toEqual({ description: false, customer: false }); // fails: both accepted
  });
});
