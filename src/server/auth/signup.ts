import type { Db } from "../db/client";
import { db } from "../db/client";
import { violatedUniqueConstraint } from "../db/errors";
import { randomSuffix, slugify, withSuffix } from "../orgs/slug";
import { hashPassword } from "./password";
import type { SignUpInput } from "./schemas";

export type SignUpResult =
  | { ok: true; userId: string; organizationId: string; slug: string }
  | { ok: false; reason: "email_taken" };

const SLUG_ATTEMPTS = 5;

/**
 * Creates the user, their organization and an OWNER membership in one transaction (DESIGN.md,
 * "Authentication"). If the email is taken, nothing is created. If the organization's slug is taken, the
 * whole transaction is retried with a random suffix, so concurrent sign-ups with the same organization name
 * all succeed. `input` must already have passed `signUpInput`.
 */
export async function signUp(input: SignUpInput, client: Db = db()): Promise<SignUpResult> {
  // Hash before opening the transaction: ~45 ms of CPU shouldn't hold a pooled connection.
  const passwordHash = await hashPassword(input.password);
  const base = slugify(input.organizationName);
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : withSuffix(base, randomSuffix());
    try {
      return await client.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash },
          select: { id: true },
        });
        const organization = await tx.organization.create({
          data: { name: input.organizationName, slug },
          select: { id: true },
        });
        await tx.membership.create({ data: { userId: user.id, organizationId: organization.id, role: "OWNER" } });
        return { ok: true as const, userId: user.id, organizationId: organization.id, slug };
      });
    } catch (error) {
      const constraint = violatedUniqueConstraint(error);
      if (constraint === "users_email_key") {
        return { ok: false, reason: "email_taken" };
      }
      if (constraint === "organizations_slug_key") {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`sign-up: no free slug for "${base}" after ${SLUG_ATTEMPTS} attempts`);
}
