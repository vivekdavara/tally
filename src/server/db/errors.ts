import { Prisma } from "@/generated/prisma/client";

/**
 * The name of the unique constraint (index) a write violated, or undefined if `error` isn't a unique
 * violation. With the pg driver adapter, Prisma 7 reports it under meta.driverAdapterError; matching the
 * constraint by name tells "email taken" from "slug taken" without parsing messages.
 */
export function violatedUniqueConstraint(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return undefined;
  }
  const cause = (error.meta?.driverAdapterError as { cause?: { constraint?: { index?: unknown } } } | undefined)
    ?.cause;
  const index = cause?.constraint?.index;
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
  const cause = (error.meta?.driverAdapterError as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}
