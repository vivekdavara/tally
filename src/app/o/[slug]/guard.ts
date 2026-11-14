import { Forbidden } from "@/server/orgs/permissions";
import type { FormState } from "../../actions";

// Not a "use server" module on purpose: every async function such a module exports becomes an endpoint a
// client can call, and this one takes a function.

/** What a member whose role lacks the permission sees (DESIGN.md, "Roles"). */
export const FORBIDDEN_MESSAGE = "Your role in this organization can't do that. Ask an owner or an admin.";

/**
 * Runs a Server Action's body, turning requireTenant's Forbidden (the role lacks the permission, checked before
 * the transaction and again inside it) into the form's error. Everything else, Next.js's redirect and 404
 * included, passes through.
 */
export async function guard(body: () => Promise<FormState>): Promise<FormState> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof Forbidden) return { error: FORBIDDEN_MESSAGE };
    throw error;
  }
}
