import { z } from "zod";

// Every input from a form passes through one of these before it reaches the database.

/** Trimmed and lower-cased: the form the database stores and its unique index is on. */
export const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254));

/**
 * 10 to 128 characters. The upper bound caps the hashing work one anonymous request can cause; the lower one
 * follows NIST 800-63B's advice to prefer length over composition rules. The minimum counts characters of
 * the NFKC form, which is what gets hashed (password.ts): five decomposed "é"s are ten UTF-16 units but five
 * characters once normalized.
 */
export const newPassword = z
  .string()
  .max(128, "Use at most 128 characters.")
  .refine((value) => [...value.normalize("NFKC")].length >= 10, "Use at least 10 characters.");

// No control characters: Postgres text can't hold NUL (a NUL made sign-up a 500), and the others have no
// place in a name shown on invoices.
const CONTROL = /\p{Cc}/u;

const name = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${what}.`)
    .max(100, `Use at most 100 characters for ${what}.`)
    .refine((value) => !CONTROL.test(value), `Remove control characters from ${what}.`);

export const signUpInput = z.object({
  name: name("your name"),
  email,
  password: newPassword,
  organizationName: name("an organization name"),
});
export type SignUpInput = z.infer<typeof signUpInput>;

/** Sign-in doesn't apply the new-password rules (they may change), only the length cap. */
export const signInInput = z.object({
  email,
  password: z.string().min(1).max(128),
});
export type SignInInput = z.infer<typeof signInInput>;
