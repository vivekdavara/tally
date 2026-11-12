// Exact money arithmetic (DESIGN.md, "Money"). Every amount is a bigint count of the currency's minor unit
// (cents for USD, yen for JPY, fils for KWD); quantities are bigint thousandths; tax rates are bigint
// thousandths of a percent. Nothing here touches a JavaScript number, so nothing is ever rounded by floating
// point. The database computes the stored totals with the same rules (migrations/*_invoicing), and
// tests/integration/totals-differential.test.ts checks the two agree.

/** The currencies Tally bills in, with ISO 4217's number of minor-unit digits. */
export const CURRENCIES = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
  INR: 2,
  JPY: 0,
  KWD: 3,
} as const;

export type Currency = keyof typeof CURRENCIES;

export function isCurrency(code: string): code is Currency {
  return Object.hasOwn(CURRENCIES, code);
}

/** Quantities are stored as numeric(12,3): thousandths. */
export const QUANTITY_SCALE = 1000n;
/** Tax rates are percentages with three decimals (8.875%), stored as numeric(6,3): thousandths of a percent. */
export const TAX_RATE_SCALE = 1000n;

// Limits chosen so the largest possible invoice still fits in Postgres bigint (9.22e18):
// 100 lines x 1,000,000 units x 10^10 minor units = 10^18, and tax at 100% doubles it to 2 x 10^18.
export const MAX_QUANTITY = 1_000_000n * QUANTITY_SCALE;
export const MAX_UNIT_PRICE_MINOR = 10_000_000_000n;
export const MAX_TAX_RATE = 100n * TAX_RATE_SCALE;
export const MAX_LINES = 100;

/** n / d rounded half up (half away from zero), for n >= 0 and d > 0: the rule every amount uses. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) {
    throw new RangeError("divRoundHalfUp: needs n >= 0 and d > 0");
  }
  return (2n * n + d) / (2n * d);
}

export class MoneyInputError extends Error {}

/**
 * Parses a non-negative decimal written with digits and at most one point ("12", "12.5", "0.125") into an
 * integer count of 10^-scaleDigits units. Refuses anything else: signs, exponents, thousands separators, more
 * fraction digits than the scale holds (they would have to be rounded, and an input is never rounded).
 */
function parseScaled(text: string, scaleDigits: number, what: string): bigint {
  const trimmed = text.trim();
  const match = /^(\d{1,19})(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyInputError(`${what} must be a number like 12 or 12.50`);
  }
  const [, whole, fraction = ""] = match;
  if (fraction.length > scaleDigits) {
    throw new MoneyInputError(
      scaleDigits === 0 ? `${what} can't have decimals` : `${what} can have at most ${scaleDigits} decimals`,
    );
  }
  return BigInt(whole! + fraction.padEnd(scaleDigits, "0"));
}

/** Formats an integer count of 10^-scaleDigits units as a decimal string ("1250", 3 → "1.250"). */
function formatScaled(value: bigint, scaleDigits: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scaleDigits + 1, "0");
  const whole = digits.slice(0, digits.length - scaleDigits);
  const fraction = digits.slice(digits.length - scaleDigits);
  return `${negative ? "-" : ""}${whole}${scaleDigits > 0 ? `.${fraction}` : ""}`;
}

/** "1.5" → 1500n thousandths. Must be > 0 and at most MAX_QUANTITY. */
export function parseQuantity(text: string): bigint {
  const value = parseScaled(text, 3, "Quantity");
  if (value <= 0n) throw new MoneyInputError("Quantity must be more than 0");
  if (value > MAX_QUANTITY) throw new MoneyInputError("Quantity can be at most 1,000,000");
  return value;
}

/** 1500n → "1.5"; whole numbers without a point ("2"). */
export function formatQuantity(thousandths: bigint): string {
  // "1.500" → "1.5", "2.000" → "2": trailing fraction zeros, then a bare point.
  return formatScaled(thousandths, 3).replace(/0+$/, "").replace(/\.$/, "");
}

/** A unit price in major units ("12.34") → minor units (1234n for USD). At most the currency's digits. */
export function parseUnitPrice(text: string, currency: Currency): bigint {
  const value = parseScaled(text, CURRENCIES[currency], "Price");
  if (value > MAX_UNIT_PRICE_MINOR) throw new MoneyInputError("Price is too large");
  return value;
}

/** "8.875" (percent) → 8875n thousandths of a percent. Between 0 and 100. */
export function parseTaxRate(text: string): bigint {
  const value = parseScaled(text === "" ? "0" : text, 3, "Tax rate");
  if (value > MAX_TAX_RATE) throw new MoneyInputError("Tax rate can be at most 100%");
  return value;
}

/** 8875n → "8.875", 20000n → "20", 7500n → "7.5". */
export function formatTaxRate(thousandths: bigint): string {
  return formatQuantity(thousandths);
}

/** Minor units as a plain decimal string in major units: 123456n USD → "1234.56". */
export function toMajorString(minor: bigint, currency: Currency): string {
  return formatScaled(minor, CURRENCIES[currency]);
}

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Minor units for display: 123456n USD → "$1,234.56". Intl.NumberFormat formats a decimal string exactly
 * (no conversion to a double on the way), so even 10^18 minor units print every digit.
 */
export function formatMoney(minor: bigint, currency: Currency, locale = "en-US", display: "symbol" | "code" = "symbol"): string {
  const key = `${locale}|${currency}|${display}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    const digits = CURRENCIES[currency];
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: display,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, formatter);
  }
  // The string overload is exact (ECMA-402 "Intl mathematical value"); the types only declare number|bigint.
  return formatter.format(toMajorString(minor, currency) as unknown as number);
}

export interface LineInput {
  quantity: bigint;
  unitPriceMinor: bigint;
  taxRate: bigint;
}

export interface TaxGroup {
  /** Thousandths of a percent. */
  rate: bigint;
  /** The sum of the line amounts taxed at this rate. */
  base: bigint;
  tax: bigint;
}

export interface Totals {
  /** Each line's amount, in input order. */
  lineAmounts: bigint[];
  subtotal: bigint;
  /** One per non-zero rate, ascending by rate. */
  taxes: TaxGroup[];
  tax: bigint;
  total: bigint;
}

/** quantity x unit price, rounded half up to the minor unit. */
export function lineAmount(line: Pick<LineInput, "quantity" | "unitPriceMinor">): bigint {
  return divRoundHalfUp(line.quantity * line.unitPriceMinor, QUANTITY_SCALE);
}

/**
 * The invoice's totals, by the rule DESIGN.md states:
 * 1. each line's amount is quantity x unit price, rounded half up to the minor unit;
 * 2. tax is computed once per rate, on the sum of that rate's line amounts, rounded half up;
 * 3. total = subtotal + the taxes, with no further rounding.
 * Rounding tax once per rate (not per line) keeps the tax within half a minor unit of the exact tax on each
 * rate's base, however many lines share it.
 */
export function computeTotals(lines: readonly LineInput[]): Totals {
  const lineAmounts = lines.map(lineAmount);
  const bases = new Map<bigint, bigint>();
  lines.forEach((line, i) => {
    bases.set(line.taxRate, (bases.get(line.taxRate) ?? 0n) + lineAmounts[i]!);
  });
  const taxes = [...bases.entries()]
    .filter(([rate]) => rate > 0n)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rate, base]) => ({ rate, base, tax: divRoundHalfUp(base * rate, 100n * TAX_RATE_SCALE) }));
  const subtotal = lineAmounts.reduce((sum, amount) => sum + amount, 0n);
  const tax = taxes.reduce((sum, group) => sum + group.tax, 0n);
  return { lineAmounts, subtotal, taxes, tax, total: subtotal + tax };
}
