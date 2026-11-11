// REVIEW 2 (mutant killer, passes at e98f346): nothing in the suite needs withTenant's second in-flight wait
// (the one after fn resolves); deleting that while-loop leaves every test green. This test is the case it is
// for: fn starts a nested write without awaiting it and returns. With the wait, the whole nested write runs
// inside the transaction (rename, user, membership all committed together). Without it, COMMIT goes out
// mid-plan and the rest runs in autocommit, where the membership insert has no tenant and is refused: a
// half-applied nested write.
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

describe("withTenant when fn returns with a write still running", () => {
  it("commits all of it inside the transaction", async () => {
    const s = unique();
    const org = await locker.organization.create({ data: { name: `unawaited ${s}`, slug: `unawaited-${s}` } });
    const email = `unawaited-${s}@example.com`;
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => (unlock = resolve));
    const holder = locker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id}::uuid FOR UPDATE`;
      await held;
    });
    await sleep(50);

    const outcome = withTenant(
      org.id,
      async (tx) => {
        void tx.organization
          .update({
            where: { id: org.id },
            data: { name: "renamed", memberships: { create: { role: "ADMIN", user: { create: { email, name: "U", passwordHash: "x" } } } } },
          })
          .catch(() => undefined);
        await sleep(100);
        return "done";
      },
      app,
    ).then(
      (v) => v,
      (e: Error) => `rejected: ${e.message}`,
    );
    await sleep(300);
    unlock();
    await holder;
    expect(await outcome).toBe("done");
    await sleep(200);

    const after = await locker.organization.findUniqueOrThrow({ where: { id: org.id }, include: { memberships: true } });
    expect({ name: after.name, members: after.memberships.length, users: await locker.user.count({ where: { email } }) }).toEqual({
      name: "renamed",
      members: 1,
      users: 1,
    });
  });
});
