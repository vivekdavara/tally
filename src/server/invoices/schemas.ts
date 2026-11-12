import { z } from "zod";
import { BIDI_CONTROL, email } from "@/server/auth/schemas";
import {
  isCurrency,
  MoneyInputError,
  parseQuantity,
  parseTaxRate,
  parseUnitPrice,
  type Currency,
} from "./money";
import { BILL_TO_ADDRESS_LINES, BILL_TO_WIDTH, wrap } from "./pdf";

// Inputs for customers, invoices and lines. Money fields arrive as the text the user typed and are parsed
// exactly here (money.ts); nothing is converted to a JavaScript number on the way.

const CONTROL = /\p{Cc}/u;
// Multi-line fields keep line breaks (as \n) and refuse every other control character.
const CONTROL_EXCEPT_NEWLINE = /[^\P{Cc}\n]/u;
// BIDI_CONTROL (auth/schemas.ts): characters that make text display in a different order from the one stored
// ("Trojan Source"), which on an invoice could make a name or an amount in a description read as something else.

const line = (what: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${what}.`)
    .max(max, `Use at most ${max} characters for ${what}.`)
    .refine((value) => !CONTROL.test(value) && !BIDI_CONTROL.test(value), `Remove control characters from ${what}.`);

const multiline = (what: string, max: number, maxLines = 20) =>
  z
    .string()
    .transform((value) => value.replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .max(max, `Use at most ${max} characters for ${what}.`)
        .refine((value) => !CONTROL_EXCEPT_NEWLINE.test(value) && !BIDI_CONTROL.test(value), `Remove control characters from ${what}.`)
        .refine((value) => value.split("\n").length <= maxLines, `Use at most ${maxLines} lines for ${what}.`),
    )
    .transform((value) => (value === "" ? null : value));

export const customerInput = z.object({
  name: line("a name", 200),
  email,
  // Six lines as typed, and no more than the PDF's bill-to block prints once it wraps them, so whatever is
  // accepted appears in full on the invoice (review round 3: counting only line breaks let a long first line
  // push the country off).
  address: multiline("the address", 500, 6).refine(
    (value) => value === null || wrap(value, 10, BILL_TO_WIDTH).length <= BILL_TO_ADDRESS_LINES,
    "Shorten the address's lines: it won't fit on the invoice.",
  ),
});
export type CustomerInput = z.infer<typeof customerInput>;

const uuid = z.uuid("Choose one from the list.");

export const currency = z
  .string()
  .refine((value): value is Currency => isCurrency(value), "Choose a supported currency.")
  .transform((value) => value as Currency);

export const draftInput = z.object({
  customerId: uuid,
  currency,
  memo: multiline("the memo", 1000),
});
export type DraftInput = z.infer<typeof draftInput>;

export const draftUpdateInput = z.object({
  customerId: uuid,
  memo: multiline("the memo", 1000),
});
export type DraftUpdateInput = z.infer<typeof draftUpdateInput>;

/** A line as typed: the money fields are parsed against the invoice's currency by parseLine. */
export const lineText = z.object({
  description: line("a description", 500),
  quantity: z.string(),
  unitPrice: z.string(),
  taxRate: z.string(),
});
export type LineText = z.infer<typeof lineText>;

export interface ParsedLine {
  description: string;
  quantity: bigint;
  unitPriceMinor: bigint;
  taxRate: bigint;
}

export type FieldErrors = Partial<Record<string, string[]>>;

/** Validates a typed line for an invoice in `currency`: the parsed line, or errors by field. */
export function parseLine(raw: unknown, currency: Currency): { ok: true; line: ParsedLine } | { ok: false; fieldErrors: FieldErrors } {
  const parsed = lineText.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }
  const fieldErrors: FieldErrors = {};
  const attempt = <T>(field: string, parse: () => T): T | undefined => {
    try {
      return parse();
    } catch (error) {
      if (!(error instanceof MoneyInputError)) throw error;
      fieldErrors[field] = [error.message];
      return undefined;
    }
  };
  const quantity = attempt("quantity", () => parseQuantity(parsed.data.quantity));
  const unitPriceMinor = attempt("unitPrice", () => parseUnitPrice(parsed.data.unitPrice, currency));
  const taxRate = attempt("taxRate", () => parseTaxRate(parsed.data.taxRate.trim()));
  if (quantity === undefined || unitPriceMinor === undefined || taxRate === undefined) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, line: { description: parsed.data.description, quantity, unitPriceMinor, taxRate } };
}

/** Days from the issue date to the due date: 0 (due on receipt) to 365. */
export const finalizeInput = z.object({
  netDays: z.coerce.number().int("Enter whole days.").min(0, "Use 0 to 365 days.").max(365, "Use 0 to 365 days."),
});
