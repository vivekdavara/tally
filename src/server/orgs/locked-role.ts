import type { Role } from "@/generated/prisma/client";
import type { TenantTx } from "../db/tenant";

/**
 * The role a user has in the transaction's organization, locked FOR SHARE until the transaction ends (a role
 * change or removal, which takes the row's update lock, waits for it), or null if they aren't a member.
 */
export async function lockedRole(tx: TenantTx, userId: string): Promise<Role | null> {
  const rows = await tx.$queryRaw<{ role: Role }[]>`
    SELECT role FROM memberships
     WHERE organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
       AND user_id = ${userId}::uuid
       FOR SHARE`;
  return rows[0]?.role ?? null;
}

/**
 * Makes this transaction's membership changes take turns with every other transaction changing memberships in the
 * same organization: the advisory lock memberships_guard takes (migrations/*_members), held to the end of the
 * transaction. requireTenant's run takes it for the member-management permissions *before* locking the actor's own
 * row: otherwise two admins changing each other's roles each hold their own row FOR SHARE and wait for the other's
 * FOR UPDATE, a deadlock (40P01) the first version had.
 */
export async function serializeMembershipChanges(tx: TenantTx): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('tally.owners:' || current_setting('app.organization_id'), 0))::text`;
}
