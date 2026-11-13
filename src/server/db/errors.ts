import { Prisma } from "@/generated/prisma/client";

interface AdapterCause {
  code?: unknown;
  originalCode?: unknown;
  kind?: unknown;
  constraint?: { index?: unknown };
}

/**
 * The pg adapter's description of the database error behind a Prisma error. Typed queries report a violation as
 * P2002/P2003; raw queries ($queryRaw, $executeRaw) as P2010, "Raw query failed", with the same cause (review of
 * day 3: a unique violation from a raw insert went unrecognised, and its "checkout-busy" answer became a 500).
 */
function adapterCause(error: unknown, codes: string[]): AdapterCause | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || !codes.includes(error.code)) {
    return undefined;
  }
  return (error.meta?.driverAdapterError as { cause?: AdapterCause } | undefined)?.cause;
}

/**
 * The name of the unique constraint (index) a write violated, or undefined if `error` isn't a unique
 * violation. With the pg driver adapter, Prisma 7 reports it under meta.driverAdapterError; matching the
 * constraint by name tells "email taken" from "slug taken" without parsing messages.
 */
export function violatedUniqueConstraint(error: unknown): string | undefined {
  const cause = adapterCause(error, ["P2002", "P2010"]);
  if (!cause || ((error as Prisma.PrismaClientKnownRequestError).code === "P2010" && cause.kind !== "UniqueConstraintViolation")) {
    return undefined;
  }
  const index = cause.constraint?.index;
  return typeof index === "string" ? index : undefined;
}

/**
 * The SQLSTATE of the database error behind a Prisma error, or undefined. The invoices_guard and
 * invoice_lines_guard triggers raise their own codes (TL001-TL009, migrations/*_invoicing), which is how the
 * services tell "this invoice is final" from a bug.
 */
export function sqlState(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }
  const cause = (error.meta?.driverAdapterError as { cause?: AdapterCause } | undefined)?.cause;
  // Errors the adapter classifies (a unique violation, say) carry the SQLSTATE as originalCode; others as code.
  const code = cause?.code ?? cause?.originalCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * The name of the foreign key a write violated, or undefined (P2003; same place as a unique violation's name).
 * A foreign-key check runs without row security, but every tenant table's keys start with organization_id, so a
 * violation only ever concerns the tenant's own rows (DESIGN.md, "Composite foreign keys").
 */
export function violatedForeignKey(error: unknown): string | undefined {
  const cause = adapterCause(error, ["P2003", "P2010"]);
  if (!cause || ((error as Prisma.PrismaClientKnownRequestError).code === "P2010" && cause.kind !== "ForeignKeyConstraintViolation")) {
    return undefined;
  }
  const index = cause.constraint?.index;
  return typeof index === "string" ? index : undefined;
}
