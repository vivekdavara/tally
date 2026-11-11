"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { signInInput, signUpInput } from "@/server/auth/schemas";
import { signUp } from "@/server/auth/signup";

export interface FormState {
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
  values?: Record<string, string>;
}

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value : "";
}

export async function signUpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const raw = {
    name: text(formData, "name"),
    email: text(formData, "email"),
    password: text(formData, "password"),
    organizationName: text(formData, "organizationName"),
  };
  // Echo back what was typed, never the password.
  const values = { name: raw.name, email: raw.email, organizationName: raw.organizationName };
  const parsed = signUpInput.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  }
  const result = await signUp(parsed.data);
  if (!result.ok) {
    return { fieldErrors: { email: ["An account with this email already exists."] }, values };
  }
  // Signs the new user in and redirects (signIn throws Next.js's redirect on success).
  await signIn("credentials", {
    email: parsed.data.email,
    password: parsed.data.password,
    redirectTo: `/o/${result.slug}`,
  });
  return {};
}

export async function signInAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const raw = { email: text(formData, "email"), password: text(formData, "password") };
  const values = { email: raw.email };
  if (!signInInput.safeParse(raw).success) {
    return { error: "Wrong email or password.", values };
  }
  try {
    await signIn("credentials", { ...raw, redirectTo: "/o" });
  } catch (error) {
    // The same message for an unknown email and a wrong password.
    if (error instanceof AuthError) {
      return { error: "Wrong email or password.", values };
    }
    // Includes the redirect that signals success.
    throw error;
  }
  return {};
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
