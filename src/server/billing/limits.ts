import type { Currency } from "@/server/invoices/money";

// What Stripe will charge (docs.stripe.com/currencies, "Minimum and maximum charge amounts", read 2026-11-13).
// An invoice can total up to 2 x 10^18 minor units (money.ts); Stripe can't take most of that range, so billing
// checks before asking, and the answer is a clear refusal rather than a provider error.

/** The minimum charge per currency, in minor units (0.50 USD = 50; 0.30 GBP = 30; 50 JPY = 50). */
export const MINIMUM_CHARGE_MINOR: Partial<Record<Currency, bigint>> = {
  USD: 50n,
  EUR: 50n,
  GBP: 30n,
  CAD: 50n,
  AUD: 50n,
  CHF: 50n,
  INR: 50n,
  JPY: 50n,
};

/**
 * The maximum, from the number of digits Stripe accepts for non-card payment methods (a checkout page can offer
 * those as well as cards, whose limit is higher): 9 digits for INR, 8 for every other currency here.
 */
export function maximumChargeMinor(currency: Currency): bigint {
  return currency === "INR" ? 999_999_999n : 99_999_999n;
}

export type Chargeability = { ok: true } | { ok: false; reason: "currency-not-chargeable" | "amount-too-small" | "amount-too-large" };

/**
 * Whether an invoice of `amountMinor` in `currency` can be paid through checkout. KWD isn't: it's a three-decimal
 * currency, which Stripe's minimum-amount table doesn't list and whose amount rules I couldn't confirm from the
 * docs, so Tally doesn't offer card payment for it rather than guess.
 */
export function chargeability(amountMinor: bigint, currency: Currency): Chargeability {
  const minimum = MINIMUM_CHARGE_MINOR[currency];
  if (minimum === undefined) return { ok: false, reason: "currency-not-chargeable" };
  if (amountMinor < minimum) return { ok: false, reason: "amount-too-small" };
  if (amountMinor > maximumChargeMinor(currency)) return { ok: false, reason: "amount-too-large" };
  return { ok: true };
}
