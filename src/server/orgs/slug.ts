import { randomBytes } from "node:crypto";

// Slugs must match the database's organizations_slug_format check: lower-case letters and digits in
// words joined by single hyphens, at most 63 characters.
export const SLUG_MAX = 63;
const BASE_MAX = 50;

/** "Acme, Inc." -> "acme-inc"; "Café Zoë" -> "cafe-zoe"; nothing usable -> "org". */
export function slugify(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = words.slice(0, BASE_MAX).replace(/-+$/, "");
  return base || "org";
}

/** A short random suffix (6 characters of [a-z0-9]) for when the plain slug is taken. */
export function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 36 doesn't divide 256: reject bytes >= 252 (7 * 36) so each character is uniform.
  let out = "";
  while (out.length < 6) {
    for (const byte of randomBytes(8)) {
      if (byte < 252 && out.length < 6) out += alphabet[byte % 36];
    }
  }
  return out;
}

export function withSuffix(base: string, suffix: string): string {
  return `${base}-${suffix}`.slice(0, SLUG_MAX);
}
