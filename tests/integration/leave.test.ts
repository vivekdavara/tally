// Leaving an organization (DESIGN.md, "Members and invitations"): anyone may leave, except its last owner, and leaving
// takes the organization's membership lock first like every other membership change, so it can't deadlock against
// an owner changing the leaver's role, and two owners leaving at once can't leave none.
// The session is mocked (Auth.js needs a request); everything else is the real action against Postgres.
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Role } from "@/generated/prisma/client";
import { changeRole, leaveOrganization } from "@/server/orgs/members";
import { refusals } from "@/server/invoices/service";
import { addMember, db, outcome, person, signInAs, sessions, world, type World } from "../fixtures/org";

vi.mock("@/auth", () => ({ auth: async () => sessions.current }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { leaveOrganizationAction } = await import("@/app/o/[slug]/members/actions");
const { requireTenant } = await import("@/server/dal");

afterAll(async () => {
  await db().$disconnect();
});

const roleOf = async (w: World, userId: string): Promise<Role | null> =>
  (await w.run((tx) => tx.membership.findUnique({ where: { organizationId_userId: { organizationId: w.organizationId, userId } }, select: { role: true } })))?.role ??
  null;

const owners = async (w: World) => (await w.run((tx) => tx.membership.findMany({ where: { organizationId: w.organizationId, role: "OWNER" }, select: { userId: true } }))).map((m) => m.userId).sort();

const LAST_OWNER = "An organization needs at least one owner. Make someone else an owner first.";

describe("leaving", () => {
  it("removes the member, who then gets the 404 a non-member gets", async () => {
    const w = await world("leave");
    signInAs(w.member);
    expect(await outcome(leaveOrganizationAction(w.slug))).toEqual({ redirect: "/o" });
    expect(await roleOf(w, w.member.userId)).toBeNull();
    expect(await outcome(requireTenant(w.slug, "view"))).toEqual({ notFound: true });
    // And again: not a member any more, so the same 404, not an error.
    expect(await outcome(leaveOrganizationAction(w.slug))).toEqual({ notFound: true });
  });

  it("refuses the last owner, who stays", async () => {
    const w = await world("lastowner");
    signInAs(w.owner);
    expect(await outcome(leaveOrganizationAction(w.slug))).toEqual({ state: { error: LAST_OWNER } });
    expect(await roleOf(w, w.owner.userId)).toBe("OWNER");
  });

  it("lets an owner leave while another owner remains", async () => {
    const w = await world("coowner");
    const second = await person("second");
    await addMember(w.organizationId, second.userId, "OWNER");
    signInAs(w.owner);
    expect(await outcome(leaveOrganizationAction(w.slug))).toEqual({ redirect: "/o" });
    expect(await owners(w)).toEqual([second.userId]);
    signInAs(second);
    expect(await outcome(leaveOrganizationAction(w.slug))).toEqual({ state: { error: LAST_OWNER } });
  });
});

describe("leaving at the same time as another membership change", () => {
  it("doesn't deadlock with an owner demoting the leaver: the demotion waits, then finds no one", async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world("leaverace");
      const leaver = await person("leaver");
      await addMember(w.organizationId, leaver.userId, "OWNER");
      signInAs(leaver);
      const leaving = await requireTenant(w.slug, "leave");
      signInAs(w.owner);
      const demoting = await requireTenant(w.slug, "manage-owners");
      // The leaver's transaction starts first and holds its locks for a moment before deleting its row; the demotion
      // starts inside that moment. Without the membership lock first, the leaver holds its own row FOR SHARE while
      // the demotion holds the organization's lock and waits for that row: each waits for the other (40P01).
      const left = leaving.run(async (tx) => {
        await tx.$executeRaw`SELECT pg_sleep(0.2)`;
        return leaveOrganization(tx, leaver.userId);
      });
      await new Promise((r) => setTimeout(r, 50));
      const demoted = refusals(() => demoting.run((tx) => changeRole(tx, w.owner.userId, leaver.userId, "MEMBER")));
      const results = await Promise.allSettled([left, demoted]);
      expect(results.map((r) => r.status), String((results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      expect((results[0] as PromiseFulfilledResult<unknown>).value).toEqual({ ok: true, value: undefined });
      expect((results[1] as PromiseFulfilledResult<unknown>).value).toEqual({ ok: false, reason: "not-found" });
      expect(await owners(w)).toEqual([w.owner.userId]);
    }
  });

  it("two owners leaving at once: one leaves, the other is refused as the last owner", async () => {
    for (let round = 0; round < 5; round++) {
      const w = await world("bothleave");
      const second = await person("both");
      await addMember(w.organizationId, second.userId, "OWNER");
      signInAs(w.owner);
      const first = await requireTenant(w.slug, "leave");
      signInAs(second);
      const other = await requireTenant(w.slug, "leave");
      const results = await Promise.all([
        refusals(() => first.run((tx) => leaveOrganization(tx, w.owner.userId))),
        refusals(() => other.run((tx) => leaveOrganization(tx, second.userId))),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "last-owner" }]);
      expect(await owners(w)).toHaveLength(1);
    }
  });
});
