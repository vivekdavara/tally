// REVIEW FINDING: when fn rejects while one of its Prisma operations is still running, withTenant's
// transaction is rolled back but the rest of that operation still runs afterwards, on the same pooled
// connection, outside any transaction, and commits.
//
// Mechanism (Prisma 7.10 client runtime + @prisma/adapter-pg): an operation looks its transaction up once
// and then runs every query of its plan on that connection; a nested write is several queries. If fn
// rejects meanwhile (a Promise.all sibling throws, a validation error, a missing await), $transaction
// queues ROLLBACK behind the running query and releases the connection when it completes. The operation's
// next query was queued after the ROLLBACK, so it runs in autocommit. On tenant tables RLS refuses it (the
// setting is '' by then), but on organizations, memberships and users the write sticks: here an
// organization rename is rolled back while the membership created in the same call is committed.
// A later query of a longer plan can even land inside the transaction of the next request that took the
// connection (after its BEGIN, before or after its set_config); not reproduced here.
//
// Suggested fix: in withTenant, pass fn a client that records every promise it hands out and, if fn
// rejects, `await Promise.allSettled(inflight)` before rethrowing (so the queries finish inside the
// transaction, which then rolls back); forbid concurrent queries on one tx (lint rule / doc). The
// underlying runtime behaviour is worth reporting upstream.
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

describe("withTenant when fn rejects during a nested write", () => {
  it("commits none of fn's writes", async () => {
    const s = unique();
    const org = await locker.organization.create({ data: { name: `stale ${s}`, slug: `stale-${s}` } });
    const user = await locker.user.create({ data: { email: `stale-${s}@example.com`, name: "U", passwordHash: "x" } });

    // Another transaction holds the organization row, so the nested write's first query (the UPDATE) is
    // still running when fn rejects: ordinary lock contention, nothing artificial.
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => (unlock = resolve));
    const holder = locker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id}::uuid FOR UPDATE`;
      await held;
    });
    await sleep(50);

    const outcome = withTenant(
      org.id,
      (tx) =>
        Promise.all([
          tx.organization.update({
            where: { id: org.id },
            data: { name: "renamed", memberships: { create: { userId: user.id, role: "ADMIN" } } },
          }),
          sleep(100).then(() => {
            throw new Error("validation failed");
          }),
        ]),
      app,
    ).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await sleep(300);
    unlock();
    await holder;
    expect(await outcome).toBe("validation failed");
    await sleep(200); // let the rest of the orphaned operation run

    const after = await locker.organization.findUniqueOrThrow({ where: { id: org.id }, include: { memberships: true } });
    expect(after.name).toBe(`stale ${s}`); // the UPDATE was rolled back...
    // ...and so should the membership be. Observed: [{ role: "ADMIN", ... }], committed after the ROLLBACK.
    expect(after.memberships).toEqual([]);
  });
});
