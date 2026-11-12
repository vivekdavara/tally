// Writes that outlive withTenant's transaction (reviews 1 and 2), rebuilt after the least-privilege
// migrations took away the organization rename the reviewers' versions started from.
//
// The mechanism (Prisma 7.10 with @prisma/adapter-pg): one operation runs every query of its plan on the
// transaction's connection. If the transaction ends while a query of the plan is running (fn rejected,
// Prisma's own timeout fired, or fn returned without awaiting it), Prisma queues COMMIT or ROLLBACK behind
// that query and releases the connection, and the plan's later queries run outside any transaction. A
// tenant-table write then fails row-level security (no tenant is set), but tables the app may insert into
// without a tenant (organizations, users) keep the orphaned write.
//
// Each test makes the plan's first query, a user insert, wait on a lock: another transaction holds an
// uncommitted user with the same email, and Postgres makes the second insert wait to see whether it commits.
// The plan's next query inserts an organization: the orphan to look for.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: Db;
let locker: Db;
let tenantId: string;

beforeAll(async () => {
  app = appDb({ max: 1 });
  locker = appDb({ max: 1 });
  tenantId = (await locker.organization.create({ data: { name: "Orphans", slug: `orphans-${unique()}` } })).id;
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), locker.$disconnect()]);
});

/** Holds an uncommitted user with `email` for `ms`, then rolls back. */
function holdEmail(email: string, ms: number): Promise<unknown> {
  return locker
    .$transaction(
      async (tx) => {
        await tx.user.create({ data: { email, name: "Holder", passwordHash: "x" } });
        await sleep(ms);
        throw new Error("holder rolls back");
      },
      { timeout: ms + 5_000 },
    )
    .catch(() => undefined);
}

/** A user insert (waits on the held email) followed by an organization insert, as one nested write. */
function nested(tx: Parameters<Parameters<typeof withTenant>[1]>[0], email: string, slug: string) {
  return tx.user.create({
    data: {
      email,
      name: "Orphan",
      passwordHash: "x",
      memberships: { create: { role: "OWNER", organization: { create: { name: "Orphan", slug } } } },
    },
  });
}

describe("withTenant and writes that outlive its transaction", () => {
  it("leaves nothing behind when fn rejects while a nested write is waiting on a lock", async () => {
    const email = `orphan-${unique()}@example.com`;
    const slug = `orphan-${unique()}`;
    const holder = holdEmail(email, 400);
    await sleep(50);
    const outcome = await withTenant(
      tenantId,
      (tx) =>
        Promise.all([
          nested(tx, email, slug),
          sleep(100).then(() => {
            throw new Error("validation failed");
          }),
        ]),
      app,
    ).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await holder;
    await sleep(200);
    expect(outcome).toBe("validation failed");
    // Without waiting for in-flight queries (round 1's bug): the organization insert ran after the ROLLBACK.
    expect(await locker.organization.count({ where: { slug } })).toBe(0);
  });

  it("leaves nothing behind when a statement waits longer than Prisma's transaction timeout would allow", async () => {
    const email = `orphan-${unique()}@example.com`;
    const slug = `orphan-${unique()}`;
    // Held for 6 s: longer than Prisma's default 5 s transaction timeout (round 2's bug), longer than
    // withTenant's 2 s lock_timeout, so the insert now fails inside the transaction instead.
    const holder = holdEmail(email, 6_000);
    await sleep(50);
    const outcome = await withTenant(tenantId, (tx) => nested(tx, email, slug), app).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    await holder;
    await sleep(300);
    expect(outcome).not.toBe("resolved");
    expect(await locker.organization.count({ where: { slug } })).toBe(0);
  }, 20_000);

  it("finishes an unawaited nested write inside the transaction, not after its COMMIT", async () => {
    // fn starts a tenant-table nested write and returns without awaiting it. Without the wait before COMMIT,
    // the customer was committed and the invoice insert after it ran outside the transaction (refused by RLS).
    const email = `c-${unique()}@example.com`;
    // The customer insert waits on another transaction's uncommitted customer with the same email, so the
    // plan is still running when fn returns (as in the reviewer's version, which waited on a row lock).
    const holder = withTenant(
      tenantId,
      async (tx) => {
        await tx.customer.create({ data: { organizationId: tenantId, name: "Holder", email } });
        await sleep(400);
        throw new Error("holder rolls back");
      },
      locker,
    ).catch(() => undefined);
    await sleep(50);
    let started: Promise<unknown> | undefined;
    // Kept (not swallowed) so a failure says why the unawaited write failed: on 2026-11-12 this test failed once
    // with 25P02 at withTenant's SELECT 1, i.e. the write itself had failed, and its error was lost.
    let startedError: unknown;
    await withTenant(
      tenantId,
      async (tx) => {
        started = tx.customer.create({
          data: {
            organizationId: tenantId,
            name: "Unawaited",
            email,
            // Three levels, so three queries: with only two, Prisma's queue order happens to put the second
            // insert ahead of COMMIT even without the wait; the third lands after it.
            invoices: {
              create: {
                currency: "USD",
                lines: { create: { position: 1, description: "Work", quantity: "1", unitPriceMinor: 100n } },
              },
            },
          },
        });
        void started.then(undefined, (error: unknown) => {
          startedError = error;
        });
      },
      app,
    ).catch((error: unknown) => {
      throw new Error(`withTenant failed (${String(error).slice(0, 200)}); the unawaited write failed with: ${String(startedError).slice(0, 500)}`);
    });
    await started?.catch(() => undefined);
    await holder;
    await sleep(200);
    const counts = await withTenant(
      tenantId,
      async (tx) => ({
        customers: await tx.customer.count({ where: { email } }),
        invoices: await tx.invoice.count({ where: { customer: { email } } }),
        lines: await tx.invoiceLine.count({ where: { invoice: { customer: { email } } } }),
      }),
      app,
    );
    expect(counts).toEqual({ customers: 1, invoices: 1, lines: 1 });
  });
});
