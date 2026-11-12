// The day-2 input schemas (src/server/invoices/schemas.ts): what a form may send for customers, drafts, lines
// and finalization, and what it becomes.
import { describe, expect, it } from "vitest";
import { currency, customerInput, draftInput, finalizeInput, parseLine } from "@/server/invoices/schemas";

describe("customerInput", () => {
  it("trims, lower-cases the email, and keeps an address's line breaks", () => {
    expect(customerInput.parse({ name: "  Navy Yard ", email: " Payables@Navy.Example ", address: "1 Dock St\r\nWashington\rDC\n" })).toEqual({
      name: "Navy Yard",
      email: "payables@navy.example",
      address: "1 Dock St\nWashington\nDC",
    });
  });

  it("takes an address of six lines, and letters from any script", () => {
    expect(customerInput.parse({ name: "東京商事", email: "n@example.com", address: "1\n2\n3\n4\n5\n6" }).address).toBe("1\n2\n3\n4\n5\n6");
    expect(customerInput.parse({ name: "شركة", email: "n@example.com", address: "" }).name).toBe("شركة");
  });

  it("stores an empty address as null", () => {
    expect(customerInput.parse({ name: "N", email: "n@example.com", address: "   \n " }).address).toBeNull();
  });

  it.each([
    ["an empty name", { name: " ", email: "n@example.com", address: "" }, "name"],
    ["a tab in the name", { name: "a\tb", email: "n@example.com", address: "" }, "name"],
    ["a NUL in the address", { name: "N", email: "n@example.com", address: "a\u0000b" }, "address"],
    ["a tab in the address", { name: "N", email: "n@example.com", address: "a\tb" }, "address"],
    ["an address over 500 characters", { name: "N", email: "n@example.com", address: "x".repeat(501) }, "address"],
    ["a name over 200 characters", { name: "x".repeat(201), email: "n@example.com", address: "" }, "name"],
    ["no email", { name: "N", email: "", address: "" }, "email"],
    ["an address of seven lines", { name: "N", email: "n@example.com", address: "1\n2\n3\n4\n5\n6\n7" }, "address"],
    ["a right-to-left override in the name", { name: "Invoice \u202egnp.exe", email: "n@example.com", address: "" }, "name"],
    ["an isolate in the address", { name: "N", email: "n@example.com", address: "a\u2066b" }, "address"],
    ["a right-to-left mark in the name", { name: "a\u200f100 200\u200f", email: "n@example.com", address: "" }, "name"],
    ["an address that wraps past what the invoice prints", { name: "N", email: "n@example.com", address: Array.from({ length: 6 }, () => "W".repeat(70)).join("\n") }, "address"],
  ])("refuses %s", (_, input, field) => {
    const result = customerInput.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0])).toContain(field);
  });
});

describe("drafts and finalization", () => {
  it("take only a supported currency, exactly as written", () => {
    expect(currency.parse("JPY")).toBe("JPY");
    for (const bad of ["jpy", "XYZ", "US", "constructor", ""]) expect(currency.safeParse(bad).success, bad).toBe(false);
  });

  it("need a customer id that is a UUID", () => {
    const id = "6f1c2a9e-1b2c-4d3e-8f9a-0b1c2d3e4f5a";
    expect(draftInput.parse({ customerId: id, currency: "USD", memo: "" })).toEqual({ customerId: id, currency: "USD", memo: null });
    expect(draftInput.safeParse({ customerId: "1 OR 1=1", currency: "USD", memo: "" }).success).toBe(false);
  });

  it("take 0 to 365 whole days of payment terms", () => {
    expect(finalizeInput.parse({ netDays: "30" })).toEqual({ netDays: 30 });
    expect(finalizeInput.parse({ netDays: "0" })).toEqual({ netDays: 0 });
    for (const bad of ["-1", "366", "1.5", "abc", "1e3"]) expect(finalizeInput.safeParse({ netDays: bad }).success, bad).toBe(false);
  });
});

describe("parseLine", () => {
  const typed = (overrides: Partial<Record<"description" | "quantity" | "unitPrice" | "taxRate", string>> = {}) => ({
    description: "Consulting",
    quantity: "1.5",
    unitPrice: "3.33",
    taxRate: "8.875",
    ...overrides,
  });

  it("parses a typed line against the invoice's currency", () => {
    expect(parseLine(typed(), "USD")).toEqual({
      ok: true,
      line: { description: "Consulting", quantity: 1500n, unitPriceMinor: 333n, taxRate: 8875n },
    });
    expect(parseLine(typed({ unitPrice: "1200" }), "JPY")).toMatchObject({ ok: true, line: { unitPriceMinor: 1200n } });
    expect(parseLine(typed({ unitPrice: "1.234" }), "KWD")).toMatchObject({ ok: true, line: { unitPriceMinor: 1234n } });
  });

  it("treats an empty tax rate as 0% and trims it", () => {
    expect(parseLine(typed({ taxRate: "" }), "USD")).toMatchObject({ ok: true, line: { taxRate: 0n } });
    expect(parseLine(typed({ taxRate: " 20 " }), "USD")).toMatchObject({ ok: true, line: { taxRate: 20000n } });
  });

  it("reports every bad field at once, by field", () => {
    const result = parseLine(typed({ quantity: "0", unitPrice: "1.005", taxRate: "101" }), "USD");
    expect(result).toEqual({
      ok: false,
      fieldErrors: {
        quantity: ["Quantity must be more than 0"],
        unitPrice: ["Price can have at most 2 decimals"],
        taxRate: ["Tax rate can be at most 100%"],
      },
    });
  });

  it("refuses a price in yen with decimals, where the same text is fine in dollars", () => {
    expect(parseLine(typed({ unitPrice: "12.50" }), "USD")).toMatchObject({ ok: true, line: { unitPriceMinor: 1250n } });
    expect(parseLine(typed({ unitPrice: "12.50" }), "JPY")).toEqual({ ok: false, fieldErrors: { unitPrice: ["Price can't have decimals"] } });
  });

  it("refuses a bidirectional override in a description", () => {
    expect(parseLine(typed({ description: "Fee \u202d$100\u202c" }), "USD")).toMatchObject({ ok: false, fieldErrors: { description: ["Remove control characters from a description."] } });
  });

  it("refuses a missing or empty description, and fields that aren't text", () => {
    expect(parseLine(typed({ description: " " }), "USD")).toMatchObject({ ok: false, fieldErrors: { description: ["Enter a description."] } });
    expect(parseLine({ description: "x", quantity: 1, unitPrice: "1", taxRate: "0" }, "USD")).toMatchObject({ ok: false });
  });
});
