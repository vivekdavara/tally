import type { Role } from "@/generated/prisma/client";
import type { Db } from "../db/client";

export interface MembershipView {
  organization: { id: string; name: string; slug: string };
  role: Role;
}

/**
 * The user's membership in the organization with this slug, or null. Null both when the organization doesn't
 * exist and when the user isn't a member, so a caller can't answer the two differently (DESIGN.md,
 * "Layer 1").
 */
export async function findMembership(client: Db, userId: string, slug: string): Promise<MembershipView | null> {
  const membership = await client.membership.findFirst({
    where: { userId, organization: { slug } },
    select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
  });
  return membership;
}

/** Every organization the user belongs to, by name. */
export async function listMemberships(client: Db, userId: string): Promise<MembershipView[]> {
  return client.membership.findMany({
    where: { userId },
    select: { role: true, organization: { select: { id: true, name: true, slug: true } } },
    orderBy: { organization: { name: "asc" } },
  });
}
