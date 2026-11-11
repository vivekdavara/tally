// REVIEW FINDING: withTenant() reports success for a transaction Postgres rolled back.
//
// If any statement inside fn fails, Postgres marks the transaction aborted. When fn catches that error (the
// natural "try to create, fall back if the unique key is taken" pattern D2 will want for customers) and
// returns, Prisma sends COMMIT; on an aborted transaction Postgres answers COMMIT with ROLLBACK and no error,
// and Prisma doesn't check the command tag. So withTenant resolves with fn's value, e.g. the id of a row
// created earlier in fn, and that row was never stored. The caller then redirects to a customer that doesn't
// exist, or worse, reports an invoice as saved.
//
// Suggested fix: after fn returns, run one statement in the transaction before committing, e.g.
// `await tx.$executeRaw\`SELECT 1\``, which fails with 25P02 (current transaction is aborted) and makes
// withTenant reject; and recommend savepoints (nested tx.$transaction) for errors fn means to recover from.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

let app: Db;

beforeAll(() => {
  app = appDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
});

describe("withTenant when fn swallows a database error", () => {
  it("doesn't resolve with a row that was never committed", async () => {
    const s = unique();
    const org = await app.organization.create({ data: { name: `swallow ${s}`, slug: `swallow-${s}` } });
    const taken = `taken-${s}@example.com`;
    await withTenant(org.id, (tx) => tx.customer.create({ data: { organizationId: org.id, name: "first", email: taken } }), app);

    const outcome = await withTenant(
      org.id,
      async (tx) => {
        const created = await tx.customer.create({ data: { organizationId: org.id, name: "second", email: `new-${s}@example.com` } });
        // A duplicate the caller expects might happen and decides to ignore.
        await tx.customer.create({ data: { organizationId: org.id, name: "dup", email: taken } }).catch(() => null);
        return created.id;
      },
      app,
    ).then(
      (id) => ({ resolved: id }),
      () => ({ rejected: true }),
    );

    const stored = await withTenant(org.id, (tx) => tx.customer.count({ where: { name: "second" } }), app);
    // Either withTenant fails, or the row it returned exists. Observed: resolved with an id, and stored === 0.
    expect("rejected" in outcome || stored === 1).toBe(true);
  });
});
