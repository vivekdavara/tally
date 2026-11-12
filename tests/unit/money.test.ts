// The money rules (DESIGN.md, "Money"): parsing refuses anything it would have to round, amounts round half
// up exactly once per line and once per tax rate, and the totals add up with no further rounding. The
// property tests compare against a reference written differently (floor plus a remainder test), on a
// seeded generator so a failure is reproducible.
import { describe, expect, it } from "vitest";
import {
  CURRENCIES,
  computeTotals,
  divRoundHalfUp,
  formatMoney,
  formatQuantity,
  formatTaxRate,
  isCurrency,
  lineAmount,
  MAX_LINES,
  MAX_QUANTITY,
  MAX_TAX_RATE,
  MAX_UNIT_PRICE_MINOR,
  MoneyInputError,
  parseQuantity,
  parseTaxRate,
  parseUnitPrice,
  toMajorString,
  type LineInput,
} from "@/server/invoices/money";
import { rng } from "../rng";


/** n/d rounded half up, written as floor plus "is the remainder at least half": the oracle. */
function referenceRound(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  return 2n * r >= d ? q + 1n : q;
}

describe("divRoundHalfUp", () => {
  it.each([
    [0n, 3n, 0n],
    [1n, 2n, 1n], // exactly half rounds up
    [3n, 2n, 2n],
    [5n, 10n, 1n],
    [4n, 10n, 0n],
    [14999n, 1000n, 15n],
    [14499n, 1000n, 14n],
    [14500n, 1000n, 15n],
  ])("%d / %d = %d", (n, d, want) => {
    expect(divRoundHalfUp(n, d)).toBe(want);
  });

  it("refuses a negative numerator or a non-positive divisor", () => {
    expect(() => divRoundHalfUp(-1n, 2n)).toThrow(RangeError);
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
  });

  it("matches the floor-and-remainder reference on 20,000 random pairs", () => {
    const next = rng(1n);
    for (let i = 0; i < 20_000; i++) {
      const n = next(10n ** 20n);
      const d = next(10n ** 6n) + 1n;
      expect(divRoundHalfUp(n, d)).toBe(referenceRound(n, d));
    }
  });
});

describe("parsing", () => {
  it.each([
    ["1", 1000n],
    ["1.5", 1500n],
    ["0.001", 1n],
    [" 2.25 ", 2250n],
    ["1000000", MAX_QUANTITY],
    ["007", 7000n],
  ])("quantity %j → %d thousandths", (text, want) => {
    expect(parseQuantity(text)).toBe(want);
  });

  it.each([["0"], ["0.000"], ["-1"], ["+1"], ["1e3"], ["1,000"], [".5"], ["1."], ["1.0005"], ["1000000.001"], [""], ["abc"], ["١٢"]])(
    "quantity %j is refused",
    (text) => {
      expect(() => parseQuantity(text)).toThrow(MoneyInputError);
    },
  );

  it("unit prices take exactly the currency's minor-unit digits", () => {
    expect(parseUnitPrice("12.34", "USD")).toBe(1234n);
    expect(parseUnitPrice("12.3", "USD")).toBe(1230n);
    expect(parseUnitPrice("0", "USD")).toBe(0n);
    expect(parseUnitPrice("1200", "JPY")).toBe(1200n);
    expect(parseUnitPrice("1.234", "KWD")).toBe(1234n);
    expect(() => parseUnitPrice("12.345", "USD")).toThrow(/at most 2 decimals/);
    expect(() => parseUnitPrice("12.5", "JPY")).toThrow(/can't have decimals/);
    expect(() => parseUnitPrice("1.2345", "KWD")).toThrow(/at most 3 decimals/);
    expect(() => parseUnitPrice("-1", "USD")).toThrow(MoneyInputError);
  });

  it("unit prices stop at MAX_UNIT_PRICE_MINOR", () => {
    expect(parseUnitPrice("100000000", "USD")).toBe(MAX_UNIT_PRICE_MINOR);
    expect(() => parseUnitPrice("100000000.01", "USD")).toThrow(/too large/);
    // 20 digits would overflow nothing (bigint), but the pattern caps the whole part at 19 digits anyway.
    expect(() => parseUnitPrice("1".repeat(20), "USD")).toThrow(MoneyInputError);
  });

  it("tax rates are percentages with up to three decimals, 0 to 100", () => {
    expect(parseTaxRate("8.875")).toBe(8875n);
    expect(parseTaxRate("20")).toBe(20000n);
    expect(parseTaxRate("")).toBe(0n);
    expect(parseTaxRate("100")).toBe(MAX_TAX_RATE);
    expect(() => parseTaxRate("100.001")).toThrow(/at most 100%/);
    expect(() => parseTaxRate("8.8755")).toThrow(/at most 3 decimals/);
    expect(() => parseTaxRate("-5")).toThrow(MoneyInputError);
  });
});

describe("formatting", () => {
  it("prints quantities and rates without trailing zeros", () => {
    expect(formatQuantity(1500n)).toBe("1.5");
    expect(formatQuantity(2000n)).toBe("2");
    expect(formatQuantity(10000n)).toBe("10");
    expect(formatQuantity(1n)).toBe("0.001");
    expect(formatQuantity(1250n)).toBe("1.25");
    expect(formatTaxRate(8875n)).toBe("8.875");
    expect(formatTaxRate(0n)).toBe("0");
  });

  it("round-trips every parsed quantity", () => {
    const next = rng(2n);
    for (let i = 0; i < 2_000; i++) {
      const q = next(MAX_QUANTITY) + 1n;
      expect(parseQuantity(formatQuantity(q))).toBe(q);
    }
  });

  it("prints minor units in major units with the currency's digits", () => {
    expect(toMajorString(123456n, "USD")).toBe("1234.56");
    expect(toMajorString(5n, "USD")).toBe("0.05");
    expect(toMajorString(5n, "KWD")).toBe("0.005");
    expect(toMajorString(1200n, "JPY")).toBe("1200");
    expect(formatMoney(123456n, "USD")).toBe("$1,234.56");
    expect(formatMoney(0n, "EUR")).toBe("€0.00");
    expect(formatMoney(1200n, "JPY")).toBe("¥1,200");
    // Intl separates a code from the amount with a no-break space.
    expect(formatMoney(1234n, "KWD")).toBe("KWD\u00a01.234");
  });

  it("prints every digit of amounts far beyond a double's 2^53", () => {
    // 2 x 10^18 is the largest total the limits allow; as a double it would print ...000.00 or worse.
    expect(formatMoney(2_000_000_000_000_000_001n, "USD")).toBe("$20,000,000,000,000,000.01");
    expect(formatMoney(9_007_199_254_740_993n, "USD")).toBe("$90,071,992,547,409.93");
  });

  it("knows each currency's digits as ISO 4217 (and so Intl) does", () => {
    for (const [code, digits] of Object.entries(CURRENCIES)) {
      const resolved = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions();
      expect(resolved.maximumFractionDigits, code).toBe(digits);
    }
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("usd")).toBe(false);
    expect(isCurrency("XYZ")).toBe(false);
    expect(isCurrency("toString")).toBe(false);
  });
});

describe("computeTotals", () => {
  const line = (quantity: bigint, unitPriceMinor: bigint, taxRate = 0n): LineInput => ({ quantity, unitPriceMinor, taxRate });

  it("rounds each line half up to the minor unit", () => {
    expect(lineAmount(line(1500n, 333n))).toBe(500n); // 499.5 → 500
    expect(lineAmount(line(1499n, 333n))).toBe(499n); // 499.167 → 499
    expect(lineAmount(line(3n, 100n))).toBe(0n); // 0.3 → 0
    expect(lineAmount(line(5n, 100n))).toBe(1n); // 0.5 → 1
  });

  it("taxes once per rate, on the sum of that rate's lines", () => {
    // Three lines of $0.10 at 5%: per-line tax would be 3 x round(0.5) = 3 cents; per rate it's round(1.5) = 2.
    const totals = computeTotals([line(1000n, 10n, 5000n), line(1000n, 10n, 5000n), line(1000n, 10n, 5000n)]);
    expect(totals.subtotal).toBe(30n);
    expect(totals.taxes).toEqual([{ rate: 5000n, base: 30n, tax: 2n }]);
    expect(totals.total).toBe(32n);
  });

  it("keeps rates apart, ascending, and leaves zero-rated lines out of the tax groups", () => {
    const totals = computeTotals([line(2000n, 1999n, 20000n), line(1000n, 500n, 0n), line(1000n, 1000n, 8875n)]);
    expect(totals.lineAmounts).toEqual([3998n, 500n, 1000n]);
    expect(totals.subtotal).toBe(5498n);
    expect(totals.taxes).toEqual([
      { rate: 8875n, base: 1000n, tax: 89n }, // 88.75 → 89
      { rate: 20000n, base: 3998n, tax: 800n }, // 799.6 → 800
    ]);
    expect(totals.tax).toBe(889n);
    expect(totals.total).toBe(6387n);
  });

  it("is zero for an empty invoice", () => {
    expect(computeTotals([])).toEqual({ lineAmounts: [], subtotal: 0n, taxes: [], tax: 0n, total: 0n });
  });

  it("fits in Postgres bigint at every limit at once", () => {
    const worst = Array.from({ length: MAX_LINES }, () => line(MAX_QUANTITY, MAX_UNIT_PRICE_MINOR, MAX_TAX_RATE));
    const totals = computeTotals(worst);
    expect(totals.total).toBe(2n * 10n ** 18n);
    expect(totals.total < 2n ** 63n).toBe(true);
  });

  it("on 3,000 random invoices: adds up, and each rounding is within half a minor unit of exact", () => {
    const next = rng(3n);
    const rates = [0n, 5000n, 8875n, 20000n, 7n, 100000n];
    for (let i = 0; i < 3_000; i++) {
      const lines = Array.from({ length: Number(next(12n)) + 1 }, () =>
        line(next(MAX_QUANTITY) + 1n, next(i % 2 === 0 ? 100_000n : MAX_UNIT_PRICE_MINOR + 1n), rates[Number(next(6n))]!),
      );
      const totals = computeTotals(lines);
      lines.forEach((l, j) => {
        expect(totals.lineAmounts[j]).toBe(referenceRound(l.quantity * l.unitPriceMinor, 1000n));
      });
      expect(totals.subtotal).toBe(totals.lineAmounts.reduce((a, b) => a + b, 0n));
      for (const group of totals.taxes) {
        const base = lines.reduce((sum, l, j) => (l.taxRate === group.rate ? sum + totals.lineAmounts[j]! : sum), 0n);
        expect(group.base).toBe(base);
        // |tax - base x rate / 100,000| <= 1/2, in integers: |100,000 tax - base x rate| x 2 <= 100,000.
        const error = 100_000n * group.tax - base * group.rate;
        expect(2n * (error < 0n ? -error : error) <= 100_000n).toBe(true);
      }
      expect(totals.tax).toBe(totals.taxes.reduce((a, g) => a + g.tax, 0n));
      expect(totals.total).toBe(totals.subtotal + totals.tax);
    }
  });

  it("doesn't depend on the order of the lines", () => {
    const next = rng(4n);
    for (let i = 0; i < 500; i++) {
      const lines = Array.from({ length: 6 }, () => line(next(10_000n) + 1n, next(100_000n), [0n, 5000n, 20000n][Number(next(3n))]!));
      const reversed = computeTotals([...lines].reverse());
      const forward = computeTotals(lines);
      expect(reversed.total).toBe(forward.total);
      expect(reversed.taxes).toEqual(forward.taxes);
    }
  });
});
