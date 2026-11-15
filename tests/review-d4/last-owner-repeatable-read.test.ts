// Review D4: memberships_guard keeps "at least one owner" only under READ COMMITTED.
//
// The bug: the trigger takes the per-organization advisory lock and then asks "is another owner left?" with a plain
// SELECT. Under READ COMMITTED that SELECT gets a fresh snapshot after the lock wait, so it sees the other
// transaction's committed demotion. But a raw-SQL writer as tally_app chooses its own isolation level: under
// REPEATABLE READ the trigger's SELECT uses the transaction's snapshot, taken at its first statement, before the
// other demotion committed. Nothing conflicts at the row level (each transaction changes a different owner's row),
// so both commit.
//
// Scenario: an organization with two owners, A and B. T2 (REPEATABLE READ, as tally_app) starts and takes its
// snapshot. T1 (READ COMMITTED) demotes A and commits (B is still an owner: allowed). T2 then demotes B: the advisory
// lock is free, and its snapshot still shows A as an owner, so the trigger lets it through.
//
// Expected: T2 is refused ("an organization keeps at least one owner", or a serialization failure), one owner left.
// Observed: both commit and the organization has zero owners.
import { afterAll, expect, it } from "vitest";
import { withTenant } from "@/server/db/tenant";
import { listMembers } from "@/server/orgs/members";
import { addMember, db, person, world } from "../fixtures/org";
import { appDb } from "../helpers";

const app = appDb({ max: 4 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), app.$disconnect()]);
});

it("keeps an owner when the second demotion runs under REPEATABLE READ", async () => {
  const w = await world("rr");
  const second = await person("rrsecond");
  await addMember(w.organizationId, second.userId, "OWNER");

  let snapshotTaken!: () => void;
  const ready = new Promise<void>((resolve) => (snapshotTaken = resolve));
  let firstCommitted!: () => void;
  const committed = new Promise<void>((resolve) => (firstCommitted = resolve));

  const t2 = app.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${w.organizationId}, true), set_config('statement_timeout', '5s', true)`;
      snapshotTaken();
      await committed;
      await tx.$executeRaw`UPDATE memberships SET role = 'MEMBER' WHERE organization_id = ${w.organizationId}::uuid AND user_id = ${second.userId}::uuid`;
    },
    { isolationLevel: "RepeatableRead", timeout: 15_000 },
  );
  await ready;
  await withTenant(
    w.organizationId,
    (tx) => tx.$executeRaw`UPDATE memberships SET role = 'MEMBER' WHERE organization_id = ${w.organizationId}::uuid AND user_id = ${w.owner.userId}::uuid`,
    app,
  );
  firstCommitted();
  const outcome = await t2.then(
    () => "committed",
    (error: unknown) => String(error),
  );

  const owners = (await w.run((tx) => listMembers(tx))).filter((m) => m.role === "OWNER");
  expect(owners.length, `second demotion: ${outcome}`).toBeGreaterThanOrEqual(1);
  expect(outcome).not.toBe("committed");
});
