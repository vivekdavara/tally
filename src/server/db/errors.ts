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
