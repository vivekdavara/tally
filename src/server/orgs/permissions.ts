import type { Role } from "@/generated/prisma/client";

// Who may do what in an organization (DESIGN.md, "Roles"). The data access layer checks one of these on every
// page and Server Action (requireTenant(slug, permission)), before the transaction and again inside it, so a role
// changed by a concurrent request is seen.

const EVERYONE = ["OWNER", "ADMIN", "MEMBER"] as const satisfies readonly Role[];
const MANAGERS = ["OWNER", "ADMIN"] as const satisfies readonly Role[];
const OWNERS = ["OWNER"] as const satisfies readonly Role[];

export const PERMISSIONS = {
  /** Every tenant page: the organization, customers, invoices, PDFs, the member list. */
  view: EVERYONE,
  /** Add, edit and delete customers. */
  "edit-customers": EVERYONE,
  /** Create, edit and delete draft invoices and their lines. */
  "edit-drafts": EVERYONE,
  /** Give a draft its number and fix its totals. */
  finalize: MANAGERS,
  /** Create a payment link for an open invoice. */
  "collect-payment": MANAGERS,
  /** Record an open invoice as paid outside the payment provider. */
  "mark-paid": MANAGERS,
  /** Cancel an open invoice. */
  void: MANAGERS,
  /** Invite people, change roles below owner, remove members below owner, revoke invitations. */
  "manage-members": MANAGERS,
  /** Make someone an owner, or change or remove an owner. */
  "manage-owners": OWNERS,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export const ROLES: readonly Role[] = EVERYONE;

export function allows(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/**
 * The permission needed to give a member `to` when they now have `from` (null: inviting someone new). Anything
 * that makes or unmakes an owner needs an owner; the rest needs a manager.
 */
export function permissionToSetRole(from: Role | null, to: Role): Permission {
  return from === "OWNER" || to === "OWNER" ? "manage-owners" : "manage-members";
}

/** The permission needed to remove a member who has `role`. */
export function permissionToRemove(role: Role): Permission {
  return role === "OWNER" ? "manage-owners" : "manage-members";
}

/** Thrown by requireTenant when the member's role lacks the permission. */
export class Forbidden extends Error {
  constructor(
    readonly permission: Permission,
    readonly role: Role,
  ) {
    super(`a ${role.toLowerCase()} may not ${permission}`);
    this.name = "Forbidden";
  }
}
