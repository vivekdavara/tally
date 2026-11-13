import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import type { VerifiedCheckoutEvent } from "./billing/events";
import { db } from "./db/client";
import { withTenant, type TenantTx } from "./db/tenant";
import { findMembership, type MembershipView } from "./orgs/memberships";

// The data access layer (DESIGN.md, "Layer 1"). Every page and Server Action that touches tenant data
// starts here. React's cache() dedupes the lookups within one request only.

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

/**
 * The signed-in user, read from the database, or null. A session whose user no longer exists counts as
 * signed out: JWTs can't be revoked, so the cookie can outlive the account. Every page that asks "is someone
 * signed in?" must use this, not the session alone, or /signin (seeing a session) and /o (finding no user)
 * redirect to each other forever.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    return null;
  }
  return db().user.findUnique({ where: { id }, select: { id: true, email: true, name: true } });
});

/** The signed-in user, or a redirect to sign in. */
export const requireUser = cache(async (): Promise<CurrentUser> => {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/signin");
  }
  return user;
});

/** The signed-in user's membership in the organization with this slug; a 404 if there isn't one. */
export const requireMembership = cache(async (slug: string): Promise<MembershipView & { user: CurrentUser }> => {
  const user = await requireUser();
  const membership = await findMembership(db(), user.id, slug);
  if (!membership) {
    notFound();
  }
  return { ...membership, user };
});

export interface Tenant extends MembershipView {
  user: CurrentUser;
  /** Runs `fn` in a withTenant transaction for this membership's organization, and no other. */
  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

/**
 * requireMembership plus a `run` bound to that membership's organization: the way pages and Server Actions
 * reach tenant data. They never hold an organization id to pass to withTenant, so they can't pass the
 * wrong one (tests/unit/architecture.test.ts checks withTenant is called only here).
 */
export async function requireTenant(slug: string): Promise<Tenant> {
  const membership = await requireMembership(slug);
  const organizationId = membership.organization.id;
  return { ...membership, run: (fn) => withTenant(organizationId, fn) };
}

/**
 * The webhook's way in (src/app/api/stripe/webhook): a transaction for the organization a Stripe event names. There
 * is no membership here; the authority is Stripe's signature over the event, which names the organization in the
 * session metadata Tally wrote. The parameter's type can only come from parseWebhook after the signature verified.
 * Row security still applies: the event's session must belong to that organization or nothing is found.
 */
export function runForStripeEvent<T>(event: VerifiedCheckoutEvent, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(event.organizationId, fn);
}
