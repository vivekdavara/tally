import { describe, expect, it } from "vitest";
import { randomSuffix, slugify, SLUG_MAX, withSuffix } from "@/server/orgs/slug";

// The database's organizations_slug_format check, as a regular expression.
const VALID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("slugify", () => {
  it.each([
    ["Acme, Inc.", "acme-inc"],
    ["  Spaces   everywhere  ", "spaces-everywhere"],
    ["Café Zoë", "cafe-zoe"],
    ["ÅNGSTRÖM labs", "angstrom-labs"],
    ["100% Organic!!", "100-organic"],
    ["---", "org"],
    ["東京", "org"],
    ["", "org"],
  ])("%j -> %j", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it("caps the base at 50 characters without leaving a trailing hyphen", () => {
    const slug = slugify(`${"a".repeat(49)} bcd`);
    expect(slug).toBe("a".repeat(49));
    expect(slugify("x".repeat(80))).toHaveLength(50);
  });

  it("always produces a slug the database accepts, with room for a suffix", () => {
    const samples = ["a", "Z", "a-b", "--a--b--", "ﬁne ﬂour", "ǅemal", "\u0000\u001f", "tab\tseparated", "émoji 🎉 co", "x".repeat(200)];
    for (let i = 0; i < 500; i++) {
      samples.push(String.fromCodePoint(...Array.from({ length: 1 + (i % 30) }, (_, j) => 32 + ((i * 7919 + j * 104729) % 0x2fff))));
    }
    for (const name of samples) {
      const slug = slugify(name);
      expect(slug, name).toMatch(VALID);
      const suffixed = withSuffix(slug, randomSuffix());
      expect(suffixed, name).toMatch(VALID);
      expect(suffixed.length).toBeLessThanOrEqual(SLUG_MAX);
    }
  });
});

describe("randomSuffix", () => {
  it("is 6 characters of [a-z0-9]", () => {
    for (let i = 0; i < 200; i++) expect(randomSuffix()).toMatch(/^[a-z0-9]{6}$/);
  });

  it("uses all 36 characters about equally (no modulo bias)", () => {
    const counts = new Map<string, number>();
    const draws = 50_000;
    for (let i = 0; i < draws; i++) for (const c of randomSuffix()) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(36);
    // 300,000 characters, so 8,333 expected each. The chi-square critical value for 35 degrees of freedom
    // at p = 1e-6 is about 90. A plain `byte % 36` (no rejection) makes a-d 8/7 as likely as the rest and
    // scored 557 here when tried.
    const expected = (draws * 6) / 36;
    const chi = [...counts.values()].reduce((sum, n) => sum + (n - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(90);
  });
});
