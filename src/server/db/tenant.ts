import type { Prisma } from "@/generated/prisma/client";
import { db, type Db } from "./client";

/** The tables row-level security protects. tests/integration/rls.test.ts checks the database agrees. */
export const TENANT_TABLES = ["customers", "invoices", "invoice_lines"] as const;

/** A transaction in which app.organization_id is set: every query in it sees one tenant's rows. */
export type TenantTx = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction whose tenant is `organizationId` (DESIGN.md, "Layer 2").
 *
 * `set_config(..., true)` makes the setting local to this transaction, so it ends with it: the pooled
 * connection goes back to the pool with no tenant, and the next request that gets it starts from nothing.
 * Row-level security then limits every query in `fn` (Prisma's and raw SQL alike) to that tenant's rows.
 * A query made on any other client inside `fn` runs on another connection, without the setting, and sees
 * no tenant rows at all.
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
    return fn(tx);
  });
}
