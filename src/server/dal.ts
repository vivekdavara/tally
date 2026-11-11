import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { db } from "./db/client";
import { findMembership, type MembershipView } from "./orgs/memberships";

// The data access layer (DESIGN.md, "Layer 1"). Every page and Server Action that touches tenant data
// starts here. React's cache() dedupes the lookups within one request only.

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
}

/** The signed-in user, read from the database (so a deleted user is signed out), or a redirect to sign in. */
export const requireUser = cache(async (): Promise<CurrentUser> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    redirect("/signin");
  }
  const user = await db().user.findUnique({ where: { id }, select: { id: true, email: true, name: true } });
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
