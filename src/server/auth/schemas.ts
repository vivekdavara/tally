import { z } from "zod";

// Every input from a form passes through one of these before it reaches the database.

/** Trimmed and lower-cased: the form the database stores and its unique index is on. */
export const email = z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(254));

/**
 * 10 to 128 characters. The upper bound caps the hashing work one anonymous request can cause; the lower one
 * follows NIST 800-63B's advice to prefer length over composition rules.
 */
export const newPassword = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.");

const name = (what: string) =>
  z.string().trim().min(1, `Enter ${what}.`).max(100, `Use at most 100 characters for ${what}.`);

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
