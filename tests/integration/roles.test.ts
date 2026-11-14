// Roles (DESIGN.md, "Roles"), enforced: every Server Action is called as an owner, an admin and a member of the
// organization, and does what the roles table says, or refuses with the Forbidden message and changes nothing.
// The session is mocked (Auth.js needs a request); everything else is the real action against Postgres.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@/generated/prisma/client";
import { invite } from "@/server/orgs/members";
import { allows, Forbidden, type Permission } from "@/server/orgs/permissions";
import { addMember, db, draft, formData, openInvoice, outcome, person, sessions, signInAs, world, type Outcome, type World } from "../fixtures/org";
import { ownerDb } from "../helpers";

vi.mock("@/auth", () => ({ auth: async () => sessions.current }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const actions = await import("@/app/o/[slug]/actions");
const memberActions = await import("@/app/o/[slug]/members/actions");
const { FORBIDDEN_MESSAGE } = await import("@/app/o/[slug]/guard");
const { requireTenant } = await import("@/server/dal");

let w: World;
const owner = ownerDb({ max: 2 });

beforeAll(async () => {
  w = await world("roles");
});

afterAll(async () => {
  await Promise.all([db().$disconnect(), owner.$disconnect()]);
});

const ROLE_OF = (role: Role) => (role === "OWNER" ? w.owner : role === "ADMIN" ? w.admin : w.member);

interface Case {
  action: string;
  /** Distinguishes several cases of one action. */
  variant?: string;
  permission: Permission;
  /** The refusal a role gets when it passes the action's first check but not the service's rank rule. */
  rankRefusal?: string;
  /** Makes what the action works on; returns the action call and a probe of the state it changes. */
  prepare(): Promise<{ call: () => Promise<unknown>; probe: () => Promise<unknown> }>;
}

const invoiceStatus = (id: string) => w.run((tx) => tx.invoice.findUnique({ where: { id }, select: { status: true } }));
const lineCount = (id: string) => w.run((tx) => tx.invoiceLine.count({ where: { invoiceId: id } }));

let n = 0;
const fresh = () => `${Date.now()}-${n++}`;

const CASES: Case[] = [
  {
    action: "createCustomerAction",
    permission: "edit-customers",
    async prepare() {
      const email = `new-${fresh()}@example.com`;
      return {
        call: () => actions.createCustomerAction(w.slug, {}, formData({ name: "New", email, address: "" })),
        probe: () => w.run((tx) => tx.customer.count({ where: { email } })),
      };
    },
  },
  {
    action: "updateCustomerAction",
    permission: "edit-customers",
    async prepare() {
      const id = await w.run(async (tx) => (await tx.customer.create({ data: { organizationId: w.organizationId, name: "Before", email: `u-${fresh()}@example.com` } })).id);
      const email = (await w.run((tx) => tx.customer.findUniqueOrThrow({ where: { id } }))).email;
      return {
        call: () => actions.updateCustomerAction(w.slug, id, {}, formData({ name: "After", email, address: "" })),
        probe: () => w.run((tx) => tx.customer.findUnique({ where: { id }, select: { name: true } })),
      };
    },
  },
  {
    action: "deleteCustomerAction",
    permission: "edit-customers",
    async prepare() {
      const id = await w.run(async (tx) => (await tx.customer.create({ data: { organizationId: w.organizationId, name: "Doomed", email: `d-${fresh()}@example.com` } })).id);
      return { call: () => actions.deleteCustomerAction(w.slug, id), probe: () => w.run((tx) => tx.customer.count({ where: { id } })) };
    },
  },
  {
    action: "createDraftAction",
    permission: "edit-drafts",
    async prepare() {
      const memo = `memo ${fresh()}`;
      return {
        call: () => actions.createDraftAction(w.slug, {}, formData({ customerId: w.customerId, currency: "USD", memo })),
        probe: () => w.run((tx) => tx.invoice.count({ where: { memo } })),
      };
    },
  },
  {
    action: "updateDraftAction",
    permission: "edit-drafts",
    async prepare() {
      const { invoiceId } = await draft(w);
      return {
        call: () => actions.updateDraftAction(w.slug, invoiceId, {}, formData({ customerId: w.customerId, memo: "changed" })),
        probe: () => w.run((tx) => tx.invoice.findUnique({ where: { id: invoiceId }, select: { memo: true } })),
      };
    },
  },
  {
    action: "addLineAction",
    permission: "edit-drafts",
    async prepare() {
      const { invoiceId } = await draft(w);
      return {
        call: () => actions.addLineAction(w.slug, invoiceId, {}, formData({ description: "More", quantity: "1", unitPrice: "1.00", taxRate: "0" })),
        probe: () => lineCount(invoiceId),
      };
    },
  },
  {
    action: "removeLineAction",
    permission: "edit-drafts",
    async prepare() {
      const { invoiceId, lineId } = await draft(w);
      return { call: () => actions.removeLineAction(w.slug, invoiceId, lineId), probe: () => lineCount(invoiceId) };
    },
  },
  {
    action: "deleteDraftAction",
    permission: "edit-drafts",
    async prepare() {
      const { invoiceId } = await draft(w);
      return { call: () => actions.deleteDraftAction(w.slug, invoiceId), probe: () => invoiceStatus(invoiceId) };
    },
  },
  {
    action: "finalizeAction",
    permission: "finalize",
    async prepare() {
      const { invoiceId } = await draft(w);
      return { call: () => actions.finalizeAction(w.slug, invoiceId, {}, formData({ netDays: "30" })), probe: () => invoiceStatus(invoiceId) };
    },
  },
  {
    action: "markPaidAction",
    permission: "mark-paid",
    async prepare() {
      const id = await openInvoice(w);
      return { call: () => actions.markPaidAction(w.slug, id), probe: () => invoiceStatus(id) };
    },
  },
  {
    action: "voidAction",
    permission: "void",
    async prepare() {
      const id = await openInvoice(w);
      return { call: () => actions.voidAction(w.slug, id), probe: () => invoiceStatus(id) };
    },
  },
  {
    action: "collectPaymentAction",
    permission: "collect-payment",
    async prepare() {
      const id = await openInvoice(w);
      return { call: () => actions.collectPaymentAction(w.slug, id), probe: () => w.run((tx) => tx.payment.count({ where: { invoiceId: id } })) };
    },
  },
];

// The members page's actions. Each needs manage-members to get in; making, changing or removing an owner needs
// manage-owners, which the service checks (an admin gets its message, a member the Forbidden one).
const OWNER_ONLY = "Only an owner can make, change or remove an owner.";
const roleIn = (userId: string) =>
  w.run((tx) => tx.membership.findUnique({ where: { organizationId_userId: { organizationId: w.organizationId, userId } }, select: { role: true } }));
const newcomer = async (role: Role) => {
  const p = await person("target");
  await addMember(w.organizationId, p.userId, role);
  return p;
};
const openInvitations = (email: string) => w.run((tx) => tx.invitation.count({ where: { email, acceptedAt: null, revokedAt: null } }));

CASES.push(
  {
    action: "inviteAction",
    permission: "manage-members",
    async prepare() {
      const email = `invited-${fresh()}@example.com`;
      return { call: () => memberActions.inviteAction(w.slug, {}, formData({ email, role: "MEMBER" })), probe: () => openInvitations(email) };
    },
  },
  {
    action: "inviteAction",
    variant: "an owner",
    permission: "manage-owners",
    rankRefusal: OWNER_ONLY,
    async prepare() {
      const email = `invited-owner-${fresh()}@example.com`;
      return { call: () => memberActions.inviteAction(w.slug, {}, formData({ email, role: "OWNER" })), probe: () => openInvitations(email) };
    },
  },
  {
    action: "changeRoleAction",
    permission: "manage-members",
    async prepare() {
      const p = await newcomer("MEMBER");
      return { call: () => memberActions.changeRoleAction(w.slug, p.userId, {}, formData({ role: "ADMIN" })), probe: () => roleIn(p.userId) };
    },
  },
  {
    action: "changeRoleAction",
    variant: "to owner",
    permission: "manage-owners",
    rankRefusal: OWNER_ONLY,
    async prepare() {
      const p = await newcomer("ADMIN");
      return { call: () => memberActions.changeRoleAction(w.slug, p.userId, {}, formData({ role: "OWNER" })), probe: () => roleIn(p.userId) };
    },
  },
  {
    action: "changeRoleAction",
    variant: "of an owner",
    permission: "manage-owners",
    rankRefusal: OWNER_ONLY,
    async prepare() {
      const p = await newcomer("OWNER");
      return { call: () => memberActions.changeRoleAction(w.slug, p.userId, {}, formData({ role: "MEMBER" })), probe: () => roleIn(p.userId) };
    },
  },
  {
    action: "removeMemberAction",
    permission: "manage-members",
    async prepare() {
      const p = await newcomer("MEMBER");
      return { call: () => memberActions.removeMemberAction(w.slug, p.userId), probe: () => roleIn(p.userId) };
    },
  },
  {
    action: "removeMemberAction",
    variant: "an owner",
    permission: "manage-owners",
    rankRefusal: OWNER_ONLY,
    async prepare() {
      const p = await newcomer("OWNER");
      return { call: () => memberActions.removeMemberAction(w.slug, p.userId), probe: () => roleIn(p.userId) };
    },
  },
  {
    action: "revokeInvitationAction",
    permission: "manage-members",
    async prepare() {
      const email = `revoke-${fresh()}@example.com`;
      const made = await w.run((tx) => invite(tx, w.owner.userId, email, "MEMBER"));
      if (!made.ok) throw new Error(made.reason);
      const id = made.value.id;
      return { call: () => memberActions.revokeInvitationAction(w.slug, id), probe: () => openInvitations(email) };
    },
  },
);

const succeeded = (o: Outcome) => "redirect" in o || ("state" in o && !o.state.error && !o.state.fieldErrors);

describe("every Server Action of /o/[slug]", () => {
  it("has a case here (a new action needs one)", () => {
    const exported = [...Object.entries(actions), ...Object.entries(memberActions)]
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k)
      .sort();
    expect(exported).toEqual([...new Set(CASES.map((c) => c.action))].sort());
  });

  for (const c of CASES) {
    for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
      const expected = allows(role, c.permission);
      it(`${c.action}${c.variant ? ` (${c.variant})` : ""} as ${role.toLowerCase()}: ${expected ? "allowed" : "refused"}`, async () => {
        const { call, probe } = await c.prepare();
        const before = await probe();
        signInAs(ROLE_OF(role));
        const result = await outcome(call());
        const after = await probe();
        if (expected) {
          expect(succeeded(result), JSON.stringify(result)).toBe(true);
          expect(after).not.toEqual(before);
        } else {
          // Members get in only with manage-members; past that, the service's rank rule refuses.
          const message = c.rankRefusal && allows(role, "manage-members") ? c.rankRefusal : FORBIDDEN_MESSAGE;
          expect(result).toMatchObject({ state: { error: message } });
          expect(result).not.toMatchObject({ state: { notice: expect.anything() } });
          expect(after).toEqual(before);
        }
      });
    }
  }
});

describe("the role is read again inside the transaction", () => {
  it("refuses an admin demoted after the request's first check, before the write", async () => {
    signInAs(w.admin);
    const tenant = await requireTenant(w.slug, "finalize");
    const { invoiceId } = await draft(w);
    await w.run((tx) => tx.membership.update({ where: { organizationId_userId: { organizationId: w.organizationId, userId: w.admin.userId } }, data: { role: "MEMBER" } }));
    try {
      await expect(tenant.run((tx) => tx.invoice.update({ where: { id: invoiceId }, data: { status: "OPEN" } }))).rejects.toBeInstanceOf(Forbidden);
      expect(await invoiceStatus(invoiceId)).toEqual({ status: "DRAFT" });
    } finally {
      await w.run((tx) => tx.membership.update({ where: { organizationId_userId: { organizationId: w.organizationId, userId: w.admin.userId } }, data: { role: "ADMIN" } }));
    }
  });

  it("answers 404 for a member removed after the first check", async () => {
    const { person, addMember } = await import("../fixtures/org");
    const gone = await person("gone");
    await addMember(w.organizationId, gone.userId, "MEMBER");
    signInAs(gone);
    const tenant = await requireTenant(w.slug, "view");
    await w.run((tx) => tx.membership.delete({ where: { organizationId_userId: { organizationId: w.organizationId, userId: gone.userId } } }));
    expect(await outcome(tenant.run((tx) => tx.customer.count()))).toEqual({ notFound: true });
  });

  it("holds the member's row FOR SHARE, so a role change waits for the action's transaction to end", async () => {
    signInAs(w.admin);
    const tenant = await requireTenant(w.slug, "finalize");
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const action = tenant.run(async () => {
      entered();
      await held;
    });
    await inside;
    // The demotion, as an owner's request would run it, on its own connection.
    const demotion = owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${w.organizationId}, true)`;
      await tx.$executeRaw`UPDATE memberships SET role = 'MEMBER' WHERE organization_id = ${w.organizationId}::uuid AND user_id = ${w.admin.userId}::uuid`;
      await tx.$executeRaw`UPDATE memberships SET role = 'ADMIN' WHERE organization_id = ${w.organizationId}::uuid AND user_id = ${w.admin.userId}::uuid`;
    });
    let waited = false;
    for (let i = 0; i < 50 && !waited; i++) {
      const rows = await owner.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE memberships SET role%' AND datname = current_database()`;
      waited = rows[0]!.n > 0n;
      if (!waited) await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await action;
    await demotion;
    expect(waited).toBe(true);
  });
});
