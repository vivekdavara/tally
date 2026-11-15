// Review D4 round 2: memberships_guard's new FOR SHARE on the other owners turns a clean "keeps at least one owner"
// refusal into a deadlock (40P01) for raw-SQL writers.
//
// The bug (migration 20261114180000_review_d4): the trigger runs with the changed row already locked, then takes the
// per-organization advisory lock, then locks the other owners FOR SHARE. So its lock order is row(self) -> advisory ->
// row(other owners). A writer that locks its target row first (SELECT ... FOR UPDATE, then UPDATE: the order
// members.ts's lockedTarget uses, minus requireTenant's advisory lock in front) holds a row the trigger now wants FOR
// SHARE, and then waits for the advisory lock that trigger holds: a cycle. The first version's plain SELECT never
// waited on another owner's row lock, so the same interleaving ended with one success and a TL018 refusal.
//
// Scenario: owners A and B, both transactions READ COMMITTED as tally_app. T2 locks B's row FOR UPDATE. T1 demotes A:
// its trigger takes the advisory lock and waits FOR SHARE on B. T2 then demotes B: its trigger waits for the advisory
// lock held by T1.
//
// Expected: T1 commits and T2 is refused with TL018 ("an organization keeps at least one owner"), as before the change.
// Observed: the deadlock detector aborts one of them with 40P01 (deadlock detected).
import { afterAll, expect, it } from "vitest";
import { addMember, db, person, world } from "../fixtures/org";
import { appDb } from "../helpers";

const app = appDb({ max: 4 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), app.$disconnect()]);
});

it("refuses the second owner removal with TL018, not a deadlock", async () => {
  const w = await world("dl");
  const b = await person("dlb");
  await addMember(w.organizationId, b.userId, "OWNER");
  const org = w.organizationId;
  const a = w.owner.userId;

  let bLocked!: () => void;
  const lockedB = new Promise<void>((resolve) => (bLocked = resolve));
  let go!: () => void;
  const t1Waiting = new Promise<void>((resolve) => (go = resolve));

  const begin = (tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) =>
    tx.$executeRaw`SELECT set_config('app.organization_id', ${org}, true), set_config('statement_timeout', '8s', true)`;
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => "committed",
      (error: unknown) => {
        const text = String(error);
        return text.includes("40P01") || /deadlock/i.test(text) ? "40P01" : text.includes("TL018") || /at least one owner/.test(text) ? "TL018" : text.slice(0, 300);
      },
    );

  const t2 = outcome(
    app.$transaction(
      async (tx) => {
        await begin(tx);
        await tx.$queryRaw`SELECT 1 FROM memberships WHERE organization_id = ${org}::uuid AND user_id = ${b.userId}::uuid FOR UPDATE`;
        bLocked();
        await t1Waiting;
        await tx.$executeRaw`UPDATE memberships SET role = 'ADMIN' WHERE organization_id = ${org}::uuid AND user_id = ${b.userId}::uuid`;
      },
      { timeout: 20_000 },
    ),
  );
  await lockedB;
  const t1 = outcome(
    app.$transaction(
      async (tx) => {
        await begin(tx);
        await tx.$executeRaw`UPDATE memberships SET role = 'ADMIN' WHERE organization_id = ${org}::uuid AND user_id = ${a}::uuid`;
      },
      { timeout: 20_000 },
    ),
  );
  await new Promise((r) => setTimeout(r, 500)); // T1 is now inside its trigger, waiting FOR SHARE on B's row
  go();
  const results = await Promise.all([t1, t2]);

  expect(results).not.toContain("40P01");
  expect(results.sort()).toEqual(["TL018", "committed"]);
});
