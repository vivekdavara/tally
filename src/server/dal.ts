import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import type { VerifiedCheckoutEvent } from "./billing/events";
import { db } from "./db/client";
import { withTenant, type TenantTx } from "./db/tenant";
import { findMembership, type MembershipView } from "./orgs/memberships";
import type { InvitationLink } from "./orgs/members";
import { allows, Forbidden, type Permission } from "./orgs/permissions";
import { lockedRole, serializeMembershipChanges } from "./orgs/locked-role";

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
  /** Whether this member's role (as read at the start of the request) allows `permission`; for showing controls. */
  can(permission: Permission): boolean;
  /**
   * Runs `fn` in a withTenant transaction for this membership's organization, and no other, after reading the
   * member's role again inside it (locked, so a concurrent role change waits): a member removed or demoted since
   * the request began gets the 404 or the Forbidden it would get now.
   */
  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
}

/**
 * requireMembership plus a `run` bound to that membership's organization: the way pages and Server Actions
 * reach tenant data. They never hold an organization id to pass to withTenant, so they can't pass the
 * wrong one (tests/unit/architecture.test.ts checks withTenant is called only here).
 *
 * `permission` is what the caller is about to do (src/server/orgs/permissions.ts). A role without it is refused
 * with Forbidden here, before any tenant data is read, and again inside `run`'s transaction. A non-member gets the
 * same 404 as a missing organization, whatever the permission.
 */
export async function requireTenant(slug: string, permission: Permission): Promise<Tenant> {
  const membership = await requireMembership(slug);
  if (!allows(membership.role, permission)) {
    throw new Forbidden(permission, membership.role);
  }
  const organizationId = membership.organization.id;
  const userId = membership.user.id;
  return {
    ...membership,
    can: (p) => allows(membership.role, p),
    run: (fn) =>
      withTenant(organizationId, async (tx) => {
        if (permission === "manage-members" || permission === "manage-owners") await serializeMembershipChanges(tx);
        const role = await lockedRole(tx, userId);
        if (!role) notFound();
        if (!allows(role, permission)) throw new Forbidden(permission, role);
        return fn(tx);
      }),
  };
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

/**
 * The invitation page's way in (src/app/invite): a transaction for the organization an invitation link names. There
 * is no membership yet; the authority is the link's secret, which the caller looks up by its digest under that
 * organization's row security, so a link naming another organization finds nothing.
 */
export function runForInvitation<T>(link: InvitationLink, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withTenant(link.organizationId, fn);
}

/**
 * Background jobs' way in (src/server/reminders/job.ts): calls `fn` for every organization in turn, oldest first,
 * with a run bound to that organization's withTenant. There is no user and no membership; the job acts for every
 * tenant, one transaction per step, so row-level security still limits each step to one of them.
 */
export async function forEachOrganization(fn: (organizationId: string, run: <T>(f: (tx: TenantTx) => Promise<T>) => Promise<T>) => Promise<void>): Promise<void> {
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const page: { id: string; createdAt: Date }[] = await db().organization.findMany({
      where: after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {},
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, createdAt: true },
      take: 200,
    });
    for (const org of page) {
      await fn(org.id, (f) => withTenant(org.id, f));
    }
    if (page.length < 200) return;
    after = page.at(-1)!;
  }
}
