import { createHash, randomBytes } from "node:crypto";
import type { Role } from "@/generated/prisma/client";
import { lockedRole } from "./locked-role";
import type { TenantTx } from "../db/tenant";
import { fail, ok, type Result } from "../invoices/service";
import { allows, permissionToRemove, permissionToSetRole } from "./permissions";

// Members and invitations (DESIGN.md, "Members and invitations"). Every function runs inside requireTenant(...).run
// (or runForInvitation), whose transaction has already locked the acting member's own row FOR SHARE; the rank rules
// (an admin can't touch an owner, only an owner makes one) are checked here against that locked role, and the
// database keeps the last owner (memberships_guard).

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  since: Date;
}

export interface InvitationView {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
}

/** The tenant of the transaction (withTenant set it): memberships are readable across organizations, so filter. */
const TENANT = "NULLIF(current_setting('app.organization_id', true), '')::uuid";

export async function listMembers(tx: TenantTx): Promise<MemberView[]> {
  return tx.$queryRawUnsafe<MemberView[]>(
    `SELECT u.id AS "userId", u.name, u.email, m.role::text AS role, m.created_at AS since
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${TENANT}
      ORDER BY m.created_at, u.email`,
  );
}

export async function listOpenInvitations(tx: TenantTx): Promise<InvitationView[]> {
  return tx.invitation.findMany({
    where: { acceptedAt: null, revokedAt: null },
    select: { id: true, email: true, role: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: "desc" },
  });
}

/** A target member's role, locked FOR UPDATE (a concurrent change of the same member waits), or null. */
async function lockTarget(tx: TenantTx, userId: string): Promise<Role | null> {
  const rows = await tx.$queryRawUnsafe<{ role: Role }[]>(
    `SELECT role FROM memberships WHERE organization_id = ${TENANT} AND user_id = $1::uuid FOR UPDATE`,
    userId,
  );
  return rows[0]?.role ?? null;
}

async function actorRole(tx: TenantTx, actorId: string): Promise<Role> {
  const role = await lockedRole(tx, actorId);
  // run() checked the actor is a member in this same transaction; their row is locked, so this can't change.
  if (!role) throw new Error("members: the acting user is not a member");
  return role;
}

/**
 * Gives a member another role. Refused ("forbidden") when the actor's role may not make that change: anything that
 * makes or unmakes an owner needs an owner. The database refuses demoting the last owner ("last-owner").
 */
export async function changeRole(tx: TenantTx, actorId: string, userId: string, role: Role): Promise<Result> {
  const actor = await actorRole(tx, actorId);
  const current = await lockTarget(tx, userId);
  if (!current) return fail("not-found");
  if (!allows(actor, permissionToSetRole(current, role))) return fail("forbidden");
  if (current === role) return ok(undefined);
  await tx.$executeRawUnsafe(`UPDATE memberships SET role = $2::membership_role WHERE organization_id = ${TENANT} AND user_id = $1::uuid`, userId, role);
  return ok(undefined);
}

/** Removes a member (an owner may remove themselves while another owner remains). */
export async function removeMember(tx: TenantTx, actorId: string, userId: string): Promise<Result> {
  const actor = await actorRole(tx, actorId);
  const current = await lockTarget(tx, userId);
  if (!current) return fail("not-found");
  if (!allows(actor, permissionToRemove(current))) return fail("forbidden");
  await tx.$executeRawUnsafe(`DELETE FROM memberships WHERE organization_id = ${TENANT} AND user_id = $1::uuid`, userId);
  return ok(undefined);
}

// Invitation links ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

declare const linkBrand: unique symbol;

/**
 * A well-formed invitation link: the organization it names and the secret. Only parseInvitationLink makes one.
 * Well-formed isn't valid: the secret is checked against the stored digest, under that organization's row security,
 * so a link naming the wrong organization finds nothing.
 */
export type InvitationLink = { organizationId: string; secret: string } & { readonly [linkBrand]: true };

/** The token in /invite/<token>: `<organization id>.<43 characters of base64url>` (32 random bytes). */
export function parseInvitationLink(token: string): InvitationLink | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const organizationId = token.slice(0, dot).toLowerCase();
  const secret = token.slice(dot + 1);
  if (!UUID.test(organizationId) || !SECRET.test(secret)) return null;
  return { organizationId, secret } as InvitationLink;
}

export function digest(secret: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash("sha256").update(secret, "utf8").digest());
}

export function linkToken(organizationId: string, secret: string): string {
  return `${organizationId}.${secret}`;
}

/**
 * Invites an email address with a role, and returns the link's token (shown once; only its digest is stored). An open
 * invitation for the same address is revoked first, so only the newest link works. Refused for an address that is
 * already a member ("already-member"), or a role the actor can't give ("forbidden").
 */
export async function invite(tx: TenantTx, actorId: string, email: string, role: Role): Promise<Result<{ id: string; token: string }>> {
  const actor = await actorRole(tx, actorId);
  if (!allows(actor, permissionToSetRole(null, role))) return fail("forbidden");
  const member = await tx.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ${TENANT} AND u.email = $1`,
    email,
  );
  if (member.length > 0) return fail("already-member");
  await tx.invitation.updateMany({ where: { email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  const secret = randomBytes(32).toString("base64url");
  const organizationId = (await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT ${TENANT}::text AS id`))[0]!.id;
  const created = await tx.invitation.create({
    data: { organizationId, email, role, tokenHash: digest(secret), invitedBy: actorId },
    select: { id: true },
  });
  return ok({ id: created.id, token: linkToken(organizationId, secret) });
}

export async function revokeInvitation(tx: TenantTx, id: string): Promise<Result> {
  const { count } = await tx.invitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  return count === 1 ? ok(undefined) : fail("not-found");
}

export interface OpenInvitation {
  id: string;
  email: string;
  role: Role;
  organization: { name: string; slug: string };
  expiresAt: Date;
}

/** The open, unexpired invitation a link stands for, or null (wrong secret, wrong organization, used, revoked, expired). */
export async function findOpenInvitation(tx: TenantTx, link: InvitationLink, lock = false): Promise<OpenInvitation | null> {
  const rows = await tx.$queryRawUnsafe<{ id: string; email: string; role: Role; expiresAt: Date; name: string; slug: string }[]>(
    `SELECT i.id, i.email, i.role::text AS role, i.expires_at AS "expiresAt", o.name, o.slug
       FROM invitations i JOIN organizations o ON o.id = i.organization_id
      WHERE i.organization_id = ${TENANT} AND i.token_hash = $1
        AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > clock_timestamp()
      ${lock ? "FOR UPDATE OF i" : ""}`,
    digest(link.secret),
  );
  const row = rows[0];
  return row ? { id: row.id, email: row.email, role: row.role, expiresAt: row.expiresAt, organization: { name: row.name, slug: row.slug } } : null;
}

/**
 * Accepts an invitation for the signed-in user: they become a member with the invited role, unless they already
 * are one (their role stays). Only the user with the invited address can accept ("wrong-email"); a link that isn't
 * open is "invalid". Returns the organization's slug.
 */
export async function acceptInvitation(tx: TenantTx, link: InvitationLink, user: { id: string; email: string }): Promise<Result<{ slug: string }>> {
  const invitation = await findOpenInvitation(tx, link, true);
  if (!invitation) return fail("invalid");
  if (invitation.email !== user.email) return fail("wrong-email");
  await tx.$executeRawUnsafe(
    `INSERT INTO memberships (organization_id, user_id, role) VALUES (${TENANT}, $1::uuid, $2::membership_role) ON CONFLICT DO NOTHING`,
    user.id,
    invitation.role,
  );
  await tx.invitation.update({ where: { id: invitation.id }, data: { acceptedBy: user.id } });
  return ok({ slug: invitation.organization.slug });
}
