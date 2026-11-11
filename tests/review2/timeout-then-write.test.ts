// REVIEW 2 FINDING: c6583bb's in-flight wait covers only "fn rejected". When the interactive transaction
// times out (Prisma's default timeout is 5 s and createDb sets none), Prisma's transaction manager rolls back
// and releases the connection on its own timer while an operation is still mid-plan: exactly round 1's
// mechanism, with no rejection in fn at all. The rest of the nested write then runs in autocommit and
// commits. Here the first query (the UPDATE) waits on an ordinary row lock for 6 s; the user insert that the
// nested write runs after it is committed although withTenant rejects and the rename is rolled back.
//
// Suggested fix: the wait can't help here (Prisma rolls back from its own timer). Either pass
// `{ timeout }` large enough plus a statement_timeout / lock_timeout below it (SET LOCAL in withTenant, so a
// statement can never outlive the transaction), or run nested writes only as single statements. Report
// upstream: closing a transaction must wait for the running operation's plan, not just its current query.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: Db;
let locker: Db;

beforeAll(() => {
  app = appDb({ max: 1 });
  locker = appDb({ max: 1 });
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), locker.$disconnect()]);
});

describe("withTenant when the transaction times out during a nested write", () => {
  it("commits none of fn's writes", async () => {
    const s = unique();
    const org = await locker.organization.create({ data: { name: `slow ${s}`, slug: `slow-${s}` } });
    const orphanEmail = `timeout-orphan-${s}@example.com`;

    let unlock!: () => void;
    const held = new Promise<void>((resolve) => (unlock = resolve));
    const holder = locker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id}::uuid FOR UPDATE`;
        await held;
      },
      { timeout: 20_000 },
    );
    await sleep(50);

    const outcome = withTenant(
      org.id,
      (tx) =>
        tx.organization.update({
          where: { id: org.id },
          data: {
            name: "renamed",
            memberships: { create: { role: "ADMIN", user: { create: { email: orphanEmail, name: "Orphan", passwordHash: "x" } } } },
          },
        }),
      app,
    ).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message.split("\n").at(-1)}`,
    );
    await sleep(6_000); // past Prisma's default 5 s interactive-transaction timeout
    unlock();
    await holder;
    const result = await outcome;
    await sleep(300);

    const after = await locker.organization.findUniqueOrThrow({ where: { id: org.id } });
    const orphans = await locker.user.count({ where: { email: orphanEmail } });
    // Observed: result "rejected: ...", name unchanged (rolled back), orphans === 1 (committed in autocommit).
    expect({ result: result.startsWith("rejected"), name: after.name, orphans }).toEqual({
      result: true,
      name: `slow ${s}`,
      orphans: 0,
    });
  }, 20_000);
});
