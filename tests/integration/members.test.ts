// Members and invitations (DESIGN.md, "Members and invitations"): the rank rules (an admin can't touch an owner or
// make one), the last owner the database keeps (memberships_guard, also when two owners demote each other at the
// same moment), and invitation links (one use, by the invited address only, for seven days, newest only, and found
// only under the organization the link names).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/generated/prisma/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { refusals } from "@/server/invoices/service";
import {
  acceptInvitation,
  changeRole,
  findOpenInvitation,
  invite,
  linkToken,
  listMembers,
  listOpenInvitations,
  parseInvitationLink,
  removeMember,
  revokeInvitation,
  type InvitationLink,
} from "@/server/orgs/members";
import { serializeMembershipChanges } from "@/server/orgs/locked-role";
import { addMember, db, person, world, type World } from "../fixtures/org";
import { adminDb, appDb, ownerDb } from "../helpers";

const admin = adminDb({ max: 2 });
const owner = ownerDb({ max: 2 });
const app = appDb({ max: 4 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), admin.$disconnect(), owner.$disconnect(), app.$disconnect()]);
});

let w: World;
beforeAll(async () => {
  w = await world("members");
});

/** A service call as `actorId`, the way requireTenant(...).run makes it: the actor's row locked first. */
const as = <T,>(actorId: string, fn: (tx: TenantTx) => Promise<T>) =>
  w.run(async (tx) => {
    await serializeMembershipChanges(tx);
    await tx.$queryRaw`SELECT 1 FROM memberships WHERE organization_id = ${w.organizationId}::uuid AND user_id = ${actorId}::uuid FOR SHARE`;
    return fn(tx);
  });

const roleOf = async (userId: string) =>
  (await w.run((tx) => tx.membership.findUnique({ where: { organizationId_userId: { organizationId: w.organizationId, userId } }, select: { role: true } })))?.role ?? null;

async function newMember(role: Role) {
  const p = await person("m");
  await addMember(w.organizationId, p.userId, role);
  return p;
}

const link = (token: string): InvitationLink => parseInvitationLink(token)!;

describe("changing roles", () => {
  it("lets an admin promote a member to admin and demote an admin to member", async () => {
    const p = await newMember("MEMBER");
    expect(await refusals(() => as(w.admin.userId, (tx) => changeRole(tx, w.admin.userId, p.userId, "ADMIN")))).toEqual({ ok: true, value: undefined });
    expect(await roleOf(p.userId)).toBe("ADMIN");
    expect((await refusals(() => as(w.admin.userId, (tx) => changeRole(tx, w.admin.userId, p.userId, "MEMBER")))).ok).toBe(true);
    expect(await roleOf(p.userId)).toBe("MEMBER");
  });

  it("refuses an admin making an owner, or changing one", async () => {
    const p = await newMember("MEMBER");
    expect(await as(w.admin.userId, (tx) => changeRole(tx, w.admin.userId, p.userId, "OWNER"))).toEqual({ ok: false, reason: "forbidden" });
    expect(await as(w.admin.userId, (tx) => changeRole(tx, w.admin.userId, w.owner.userId, "MEMBER"))).toEqual({ ok: false, reason: "forbidden" });
    expect([await roleOf(p.userId), await roleOf(w.owner.userId)]).toEqual(["MEMBER", "OWNER"]);
  });

  it("lets an owner make an owner, and then step down", async () => {
    const other = await world("handover");
    const p = await person("heir");
    await addMember(other.organizationId, p.userId, "ADMIN");
    const asOwner = (fn: (tx: TenantTx) => Promise<unknown>) => other.run(fn);
    expect((await asOwner((tx) => changeRole(tx, other.owner.userId, p.userId, "OWNER"))) as { ok: boolean }).toMatchObject({ ok: true });
    expect((await refusals(() => asOwner((tx) => changeRole(tx, other.owner.userId, other.owner.userId, "MEMBER")) as never)) as { ok: boolean }).toMatchObject({ ok: true });
    const members = await other.run((tx) => listMembers(tx));
    expect(members.filter((m) => m.role === "OWNER").map((m) => m.userId)).toEqual([p.userId]);
  });

  it("refuses demoting the last owner (the database's rule), whoever asks", async () => {
    const solo = await world("solo");
    expect(await refusals(() => solo.run((tx) => changeRole(tx, solo.owner.userId, solo.owner.userId, "ADMIN")))).toEqual({ ok: false, reason: "last-owner" });
    // Raw SQL as the app role, past the service: the trigger refuses it too.
    await expect(
      withTenant(solo.organizationId, (tx) => tx.$executeRaw`UPDATE memberships SET role = 'MEMBER' WHERE user_id = ${solo.owner.userId}::uuid`, app),
    ).rejects.toThrow(/at least one owner/);
  });

  it("keeps an owner when two owners demote each other at the same moment", async () => {
    for (let round = 0; round < 5; round++) {
      const pair = await world("pair");
      const second = await person("second");
      await addMember(pair.organizationId, second.userId, "OWNER");
      // The way requireTenant(..., "manage-owners").run makes the call: the organization's membership lock, then the
      // actor's own row FOR SHARE, then the service.
      const demote = (actor: string, target: string) =>
        refusals(() =>
          pair.run(async (tx) => {
            await serializeMembershipChanges(tx);
            await tx.$queryRaw`SELECT 1 FROM memberships WHERE organization_id = ${pair.organizationId}::uuid AND user_id = ${actor}::uuid FOR SHARE`;
            return changeRole(tx, actor, target, "MEMBER");
          }),
        );
      const results = await Promise.all([demote(pair.owner.userId, second.userId), demote(second.userId, pair.owner.userId)]);
      const owners = (await pair.run((tx) => listMembers(tx))).filter((m) => m.role === "OWNER");
      expect(owners).toHaveLength(1);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    }
  });

  it("keeps an owner against raw SQL too: two transactions demoting the two owners overlap, the second is refused", async () => {
    const pair = await world("rawpair");
    const second = await person("rawsecond");
    await addMember(pair.organizationId, second.userId, "OWNER");
    const demote = (userId: string, holdMs: number) =>
      withTenant(
        pair.organizationId,
        async (tx) => {
          await tx.$executeRaw`UPDATE memberships SET role = 'MEMBER' WHERE user_id = ${userId}::uuid`;
          await tx.$executeRaw`SELECT pg_sleep(${holdMs / 1000})`;
        },
        app,
      );
    const first = demote(pair.owner.userId, 300);
    await new Promise((r) => setTimeout(r, 100));
    const results = await Promise.allSettled([first, demote(second.userId, 0)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/at least one owner/);
    expect((await pair.run((tx) => listMembers(tx))).filter((m) => m.role === "OWNER").map((m) => m.userId)).toEqual([second.userId]);
  });

  it("refuses changing a membership's user or organization (grants), and the trigger refuses the owner role too", async () => {
    await expect(withTenant(w.organizationId, (tx) => tx.$executeRaw`UPDATE memberships SET user_id = user_id WHERE user_id = ${w.member.userId}::uuid`, app)).rejects.toThrow(
      /permission denied/,
    );
    const other = await person("x");
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${w.organizationId}, true)`;
        await tx.$executeRaw`UPDATE memberships SET user_id = ${other.userId}::uuid WHERE organization_id = ${w.organizationId}::uuid AND user_id = ${w.member.userId}::uuid`;
      }),
    ).rejects.toThrow(/only a membership's role can change/);
  });
});

describe("removing members", () => {
  it("lets an admin remove a member, not an owner", async () => {
    const p = await newMember("MEMBER");
    expect((await as(w.admin.userId, (tx) => removeMember(tx, w.admin.userId, p.userId))).ok).toBe(true);
    expect(await roleOf(p.userId)).toBeNull();
    expect(await as(w.admin.userId, (tx) => removeMember(tx, w.admin.userId, w.owner.userId))).toEqual({ ok: false, reason: "forbidden" });
    expect(await roleOf(w.owner.userId)).toBe("OWNER");
  });

  it("refuses removing the last owner, but an administrator can still delete that user (the cascade is let through)", async () => {
    const solo = await world("lone");
    expect(await refusals(() => solo.run((tx) => removeMember(tx, solo.owner.userId, solo.owner.userId)))).toEqual({ ok: false, reason: "last-owner" });
    await owner.$executeRaw`DELETE FROM users WHERE id = ${solo.owner.userId}::uuid`;
    expect(await owner.$queryRaw<unknown[]>`SELECT 1 FROM memberships WHERE user_id = ${solo.owner.userId}::uuid`).toEqual([]);
  });

  it("answers not-found for someone who isn't a member", async () => {
    const stranger = await person("stranger");
    expect(await as(w.owner.userId, (tx) => removeMember(tx, w.owner.userId, stranger.userId))).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("invitations", () => {
  const inviteAs = (actorId: string, email: string, role: Role) => refusals(() => as(actorId, (tx) => invite(tx, actorId, email, role)));

  it("makes the invited user a member with the invited role, once", async () => {
    const p = await person("invitee");
    const result = await inviteAs(w.admin.userId, p.email, "ADMIN");
    if (!result.ok) throw new Error(result.reason);
    const l = link(result.value.token);
    expect(await w.run((tx) => findOpenInvitation(tx, l))).toMatchObject({ email: p.email, role: "ADMIN", organization: { slug: w.slug } });
    expect(await refusals(() => withTenant(l.organizationId, (tx) => acceptInvitation(tx, l, { id: p.userId, email: p.email })))).toEqual({ ok: true, value: { slug: w.slug } });
    expect(await roleOf(p.userId)).toBe("ADMIN");
    // A second use finds nothing open.
    expect(await refusals(() => withTenant(l.organizationId, (tx) => acceptInvitation(tx, l, { id: p.userId, email: p.email })))).toEqual({ ok: false, reason: "invalid" });
  });

  it("stores only a digest of the secret", async () => {
    const p = await person("digest");
    const result = await inviteAs(w.owner.userId, p.email, "MEMBER");
    if (!result.ok) throw new Error(result.reason);
    const secret = result.value.token.split(".")[1]!;
    const rows = await admin.$queryRaw<{ hex: string }[]>`SELECT encode(token_hash, 'hex') AS hex FROM invitations WHERE id = ${result.value.id}::uuid`;
    expect(rows[0]!.hex).toHaveLength(64);
    expect(rows[0]!.hex).not.toContain(Buffer.from(secret, "base64url").toString("hex"));
  });

  it("can't be accepted by another account, even with the link", async () => {
    const p = await person("meant");
    const thief = await person("thief");
    const result = await inviteAs(w.owner.userId, p.email, "MEMBER");
    if (!result.ok) throw new Error(result.reason);
    const l = link(result.value.token);
    expect(await withTenant(l.organizationId, (tx) => acceptInvitation(tx, l, { id: thief.userId, email: thief.email }))).toEqual({ ok: false, reason: "wrong-email" });
    expect(await roleOf(thief.userId)).toBeNull();
  });

  it("is found only under the organization the link names (another organization's id finds nothing)", async () => {
    const p = await person("cross");
    const result = await inviteAs(w.owner.userId, p.email, "MEMBER");
    if (!result.ok) throw new Error(result.reason);
    const secret = result.value.token.split(".")[1]!;
    const elsewhere = await world("elsewhere");
    const forged = link(linkToken(elsewhere.organizationId, secret));
    expect(await withTenant(forged.organizationId, (tx) => findOpenInvitation(tx, forged))).toBeNull();
    expect(await withTenant(forged.organizationId, (tx) => acceptInvitation(tx, forged, { id: p.userId, email: p.email }))).toEqual({ ok: false, reason: "invalid" });
    expect(await withTenant(elsewhere.organizationId, (tx) => tx.membership.count({ where: { userId: p.userId, organizationId: elsewhere.organizationId } }))).toBe(0);
  });

  it("replaces an open invitation for the same address: only the newest link works", async () => {
    const p = await person("again");
    const first = await inviteAs(w.owner.userId, p.email, "MEMBER");
    const second = await inviteAs(w.owner.userId, p.email, "ADMIN");
    if (!first.ok || !second.ok) throw new Error("invite failed");
    expect(await w.run((tx) => findOpenInvitation(tx, link(first.value.token)))).toBeNull();
    expect(await w.run((tx) => findOpenInvitation(tx, link(second.value.token)))).toMatchObject({ role: "ADMIN" });
    expect((await w.run((tx) => listOpenInvitations(tx))).filter((i) => i.email === p.email)).toHaveLength(1);
  });

  it("stops working when revoked or expired", async () => {
    const p = await person("closed");
    const revoked = await inviteAs(w.owner.userId, p.email, "MEMBER");
    if (!revoked.ok) throw new Error(revoked.reason);
    expect((await w.run((tx) => revokeInvitation(tx, revoked.value.id))).ok).toBe(true);
    expect(await w.run((tx) => findOpenInvitation(tx, link(revoked.value.token)))).toBeNull();

    const q = await person("late");
    const late = await inviteAs(w.owner.userId, q.email, "MEMBER");
    if (!late.ok) throw new Error(late.reason);
    // Seven days pass: moved back by a superuser with triggers off (nothing the app can do).
    await admin.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`UPDATE invitations SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${late.value.id}::uuid`;
    });
    const l = link(late.value.token);
    expect(await w.run((tx) => findOpenInvitation(tx, l))).toBeNull();
    expect(await refusals(() => w.run((tx) => acceptInvitation(tx, l, { id: q.userId, email: q.email })))).toEqual({ ok: false, reason: "invalid" });
    // Past the service: the trigger refuses accepting it.
    await expect(w.run((tx) => tx.invitation.update({ where: { id: late.value.id }, data: { acceptedBy: q.userId } }))).rejects.toThrow(/expired/);
  });

  it("refuses an admin inviting an owner, and an address that is already a member", async () => {
    expect(await inviteAs(w.admin.userId, "boss@example.com", "OWNER")).toEqual({ ok: false, reason: "forbidden" });
    expect((await inviteAs(w.owner.userId, `boss-${Date.now()}@example.com`, "OWNER")).ok).toBe(true);
    expect(await inviteAs(w.owner.userId, w.member.email, "ADMIN")).toEqual({ ok: false, reason: "already-member" });
  });

  it("keeps an accepting member's existing role", async () => {
    const p = await newMember("ADMIN");
    // Invited while not yet a member is the usual case; here the invitation predates the membership.
    await w.run((tx) => tx.membership.delete({ where: { organizationId_userId: { organizationId: w.organizationId, userId: p.userId } } }));
    const result = await inviteAs(w.owner.userId, p.email, "MEMBER");
    if (!result.ok) throw new Error(result.reason);
    await addMember(w.organizationId, p.userId, "ADMIN");
    const l = link(result.value.token);
    expect((await w.run((tx) => acceptInvitation(tx, l, { id: p.userId, email: p.email }))).ok).toBe(true);
    expect(await roleOf(p.userId)).toBe("ADMIN");
  });

  it("are written once: the app can't change their address, role or token, or delete them", async () => {
    const p = await person("frozen");
    const result = await inviteAs(w.owner.userId, p.email, "MEMBER");
    if (!result.ok) throw new Error(result.reason);
    const id = result.value.id;
    for (const sql of [
      `UPDATE invitations SET role = 'OWNER' WHERE id = '${id}'`,
      `UPDATE invitations SET email = 'other@example.com' WHERE id = '${id}'`,
      `UPDATE invitations SET expires_at = expires_at + interval '1 year' WHERE id = '${id}'`,
      `DELETE FROM invitations WHERE id = '${id}'`,
    ]) {
      await expect(withTenant(w.organizationId, (tx) => tx.$executeRawUnsafe(sql), app), sql).rejects.toThrow(/permission denied/);
    }
    // The owner role has the grants; the trigger stops it.
    await expect(
      owner.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.organization_id', ${w.organizationId}, true)`;
        await tx.$executeRawUnsafe(`UPDATE invitations SET role = 'OWNER' WHERE id = '${id}'`);
      }),
    ).rejects.toThrow(/only whether an invitation was accepted or revoked/);
  });

  it("parse only well-formed links", () => {
    const org = "0b6f0a4e-8c55-4c1e-9a43-1f0e3b9f7d21";
    const secret = "A".repeat(43);
    expect(parseInvitationLink(`${org}.${secret}`)).toEqual({ organizationId: org, secret });
    for (const bad of ["", org, `${org}.`, `${org}.${"A".repeat(42)}`, `${org}.${"A".repeat(44)}`, `${org}.${"A".repeat(42)}=`, `not-a-uuid.${secret}`, `${org}.${secret}.x`]) {
      expect(parseInvitationLink(bad), bad).toBeNull();
    }
  });
});
