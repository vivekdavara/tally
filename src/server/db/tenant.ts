import type { Prisma } from "@/generated/prisma/client";
import { db, type Db } from "./client";

/** The tables row-level security protects. tests/integration/rls.test.ts checks the database agrees. */
export const TENANT_TABLES = ["customers", "invoices", "invoice_lines"] as const;

/** A transaction in which app.organization_id is set: every query in it sees one tenant's rows. */
export type TenantTx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Wraps a Prisma promise (which runs only when someone calls `then`) so that once it starts, it's recorded
 * in `inflight` until it settles. Starting stays lazy: a query fn builds but never awaits doesn't run.
 */
function tracked<T>(lazy: PromiseLike<T>, inflight: Set<Promise<unknown>>): Promise<T> {
  let started: Promise<T> | undefined;
  const start = () => {
    if (!started) {
      const run = Promise.resolve(lazy);
      started = run;
      inflight.add(run);
      run.then(
        () => inflight.delete(run),
        () => inflight.delete(run),
      );
    }
    return started;
  };
  return {
    then: (onFulfilled, onRejected) => start().then(onFulfilled, onRejected),
    catch: (onRejected) => start().catch(onRejected),
    finally: (onFinally) => start().finally(onFinally),
    [Symbol.toStringTag]: "TrackedPrismaPromise",
  } as Promise<T>;
}

/** A view of `target` whose methods (and model delegates' methods) return tracked promises. */
function tracking<T extends object>(target: T, inflight: Set<Promise<unknown>>): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(object, args);
          return isThenable(result) ? tracked(result, inflight) : result;
        };
      }
      // Model delegates (tx.customer, tx.invoice, ...) are objects whose methods return Prisma promises.
      if (typeof value === "object" && value !== null && typeof property === "string" && !property.startsWith("_")) {
        return tracking(value, inflight);
      }
      return value;
    },
  });
}

/**
 * Runs `fn` in one transaction whose tenant is `organizationId` (DESIGN.md, "Layer 2").
 *
 * `set_config(..., true)` makes the setting local to this transaction, so it ends with it: the pooled
 * connection goes back to the pool with no tenant, and the next request that gets it starts from nothing.
 * Row-level security then limits every query in `fn` (Prisma's and raw SQL alike) to that tenant's rows.
 * A query made on any other client inside `fn` runs on another connection, without the setting, and sees
 * no tenant rows at all.
 *
 * Two guards around `fn`, each for a way the transaction's outcome and its writes could disagree:
 * - If `fn` rejects while one of its queries is still running (a Promise.all sibling threw), wait for the
 *   running queries before rolling back. Prisma 7.10 otherwise sends ROLLBACK and releases the connection,
 *   and the rest of a multi-query operation (a nested write) then runs outside any transaction and commits.
 * - If `fn` caught a database error and returned normally, Postgres has already aborted the transaction and
 *   would answer COMMIT with a silent ROLLBACK; one more statement makes that an error instead of a success
 *   for writes that were never stored.
 *
 * `organizationId` must come from a membership check (src/server/dal.ts), never straight from a request.
 */
export async function withTenant<T>(
  organizationId: string,
  fn: (tx: TenantTx) => Promise<T>,
  client: Db = db(),
): Promise<T> {
  if (!UUID.test(organizationId)) {
    throw new TypeError("withTenant: organizationId must be a UUID");
  }
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
    const inflight = new Set<Promise<unknown>>();
    let result: T;
    try {
      result = await fn(tracking(tx, inflight));
    } catch (error) {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
      throw error;
    }
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight]);
    }
    // Fails with 25P02 ("current transaction is aborted") if fn swallowed a database error.
    await tx.$executeRaw`SELECT 1`;
    return result;
  });
}
