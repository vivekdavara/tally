import type { Prisma } from "@/generated/prisma/client";
import { sqlState, violatedUniqueConstraint } from "@/server/db/errors";
import type { TenantTx } from "@/server/db/tenant";
import { computeTotals, MAX_LINES, type Currency, type Totals } from "./money";
import type { CustomerInput, DraftInput, DraftUpdateInput, ParsedLine } from "./schemas";

// Customers and invoices, inside one tenant's transaction (DESIGN.md, "Invoices"). Every function takes the
// TenantTx that requireTenant(...).run gives, so row-level security limits it to that organization; an id
// from another organization behaves exactly like an id that doesn't exist. The database enforces the
// invoice life cycle itself (the invoices_guard and invoice_lines_guard triggers); these functions check the
// same rules first so the usual mistakes get a clear answer, and map the triggers' codes for the rest.

export type Result<T = undefined> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (reason: string): Result<never> => ({ ok: false, reason });

/** The organization this transaction is bound to: the setting row-level security reads. */
async function tenantId(tx: TenantTx): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string | null }[]>`SELECT NULLIF(current_setting('app.organization_id', true), '') AS id`;
  const id = rows[0]?.id;
  if (!id) throw new Error("no tenant set: call this inside requireTenant(...).run");
  return id;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Customers -------------------------------------------------------------------------------------------------

export async function listCustomers(tx: TenantTx) {
  return tx.customer.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, email: true } });
}

export async function getCustomer(tx: TenantTx, id: string) {
  if (!UUID.test(id)) return null;
  return tx.customer.findUnique({ where: { id }, select: { id: true, name: true, email: true, address: true } });
}

export async function createCustomer(tx: TenantTx, input: CustomerInput): Promise<Result<string>> {
  const organizationId = await tenantId(tx);
  try {
    const created = await tx.customer.create({ data: { organizationId, ...input }, select: { id: true } });
    return ok(created.id);
  } catch (error) {
    // Unique per organization (organization_id first), so this can only mean this organization's customer.
    if (violatedUniqueConstraint(error) === "customers_organization_id_email_key") return fail("email-taken");
    throw error;
  }
}

export async function updateCustomer(tx: TenantTx, id: string, input: CustomerInput): Promise<Result> {
  if (!UUID.test(id)) return fail("not-found");
  try {
    const { count } = await tx.customer.updateMany({ where: { id }, data: input });
    return count === 1 ? ok(undefined) : fail("not-found");
  } catch (error) {
    if (violatedUniqueConstraint(error) === "customers_organization_id_email_key") return fail("email-taken");
    throw error;
  }
}

/** Only a customer with no invoices can be deleted (the invoices' foreign key refuses otherwise). */
export async function deleteCustomer(tx: TenantTx, id: string): Promise<Result> {
  if (!UUID.test(id)) return fail("not-found");
  if ((await tx.invoice.count({ where: { customerId: id } })) > 0) return fail("has-invoices");
  const { count } = await tx.customer.deleteMany({ where: { id } });
  return count === 1 ? ok(undefined) : fail("not-found");
}

// Invoices --------------------------------------------------------------------------------------------------

// Quantities and tax rates are numeric(_, 3) in the database and bigint thousandths here (money.ts).
const thousandths = (value: Prisma.Decimal): bigint => BigInt(value.toFixed(3).replace(".", ""));

const fromThousandths = (value: bigint): string => {
  const text = value.toString().padStart(4, "0");
  return `${text.slice(0, -3)}.${text.slice(-3)}`;
};

export interface InvoiceLineView {
  id: string;
  position: number;
  description: string;
  quantity: bigint;
  unitPriceMinor: bigint;
  taxRate: bigint;
  amount: bigint;
}

export interface InvoiceView {
  id: string;
  number: number | null;
  status: "DRAFT" | "OPEN" | "PAID" | "VOID";
  currency: Currency;
  memo: string | null;
  issuedAt: Date | null;
  dueOn: Date | null;
  createdAt: Date;
  customer: { id: string; name: string; email: string; address: string | null };
  lines: InvoiceLineView[];
  totals: Totals;
}

const lineSelect = { id: true, position: true, description: true, quantity: true, unitPriceMinor: true, taxRate: true } as const;

function toLineInputs(lines: { quantity: Prisma.Decimal; unitPriceMinor: bigint; taxRate: Prisma.Decimal }[]) {
  return lines.map((l) => ({
    quantity: thousandths(l.quantity),
    unitPriceMinor: l.unitPriceMinor,
    taxRate: thousandths(l.taxRate),
  }));
}

export class TotalsMismatchError extends Error {}

/**
 * One invoice with its customer, lines and totals. For a finalized invoice the totals are the ones the
 * database stored; they are checked against money.ts's computation from the lines, and a disagreement is
 * an error, never an invoice printed with two different totals.
 */
export async function getInvoice(tx: TenantTx, id: string): Promise<InvoiceView | null> {
  if (!UUID.test(id)) return null;
  const row = await tx.invoice.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, email: true, address: true } },
      lines: { select: lineSelect, orderBy: { position: "asc" } },
    },
  });
  if (!row) return null;
  const inputs = toLineInputs(row.lines);
  const totals = computeTotals(inputs);
  if (row.status !== "DRAFT") {
    const stored = { subtotal: row.subtotalMinor, tax: row.taxMinor, total: row.totalMinor };
    if (stored.subtotal !== totals.subtotal || stored.tax !== totals.tax || stored.total !== totals.total) {
      throw new TotalsMismatchError(`invoice ${row.number}: stored totals differ from its lines`);
    }
  }
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency as Currency,
    memo: row.memo,
    issuedAt: row.issuedAt,
    dueOn: row.dueOn,
    createdAt: row.createdAt,
    customer: row.customer,
    lines: row.lines.map((l, i) => ({ ...l, ...inputs[i]!, amount: totals.lineAmounts[i]! })),
    totals,
  };
}

export interface InvoiceSummary {
  id: string;
  number: number | null;
  status: InvoiceView["status"];
  currency: Currency;
  customerName: string;
  total: bigint;
  dueOn: Date | null;
  createdAt: Date;
}

/** The newest invoices first. Drafts' totals are computed from their lines; others' are as stored. */
export async function listInvoices(tx: TenantTx, take = 100): Promise<InvoiceSummary[]> {
  const rows = await tx.invoice.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take,
    include: {
      customer: { select: { name: true } },
      lines: { select: { quantity: true, unitPriceMinor: true, taxRate: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency as Currency,
    customerName: row.customer.name,
    total: row.totalMinor ?? computeTotals(toLineInputs(row.lines)).total,
    dueOn: row.dueOn,
    createdAt: row.createdAt,
  }));
}

export async function createDraft(tx: TenantTx, input: DraftInput): Promise<Result<string>> {
  const organizationId = await tenantId(tx);
  // Another organization's customer is invisible here, so it reads as missing (and the composite foreign
  // key would refuse it anyway, with the same error as a random id).
  if ((await tx.customer.count({ where: { id: input.customerId } })) !== 1) return fail("no-customer");
  const created = await tx.invoice.create({
    data: { organizationId, customerId: input.customerId, currency: input.currency, memo: input.memo },
    select: { id: true },
  });
  return ok(created.id);
}

/**
 * Locks the invoice row for this transaction (FOR NO KEY UPDATE, the lock invoice_lines_guard takes) and
 * returns its status and currency, or null if it isn't visible. Line edits take it first, so their
 * position arithmetic can't race another edit or a finalization.
 */
async function lockInvoice(tx: TenantTx, id: string): Promise<{ status: string; currency: Currency } | null> {
  if (!UUID.test(id)) return null;
  const rows = await tx.$queryRaw<{ status: string; currency: string }[]>`
    SELECT status::text AS status, currency FROM invoices WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
  const row = rows[0];
  return row ? { status: row.status, currency: row.currency as Currency } : null;
}

export async function updateDraft(tx: TenantTx, id: string, input: DraftUpdateInput): Promise<Result> {
  const invoice = await lockInvoice(tx, id);
  if (!invoice) return fail("not-found");
  if (invoice.status !== "DRAFT") return fail("final");
  if ((await tx.customer.count({ where: { id: input.customerId } })) !== 1) return fail("no-customer");
  await tx.invoice.update({ where: { id }, data: { customerId: input.customerId, memo: input.memo } });
  return ok(undefined);
}

/** The currency the line's prices must be in, for parsing a typed line before addLine/updateLine. */
export async function invoiceCurrency(tx: TenantTx, id: string): Promise<Currency | null> {
  if (!UUID.test(id)) return null;
  const row = await tx.invoice.findUnique({ where: { id }, select: { currency: true } });
  return row ? (row.currency as Currency) : null;
}

const lineData = (line: ParsedLine) => ({
  description: line.description,
  quantity: fromThousandths(line.quantity),
  unitPriceMinor: line.unitPriceMinor,
  taxRate: fromThousandths(line.taxRate),
});

export async function addLine(tx: TenantTx, invoiceId: string, line: ParsedLine): Promise<Result<string>> {
  const invoice = await lockInvoice(tx, invoiceId);
  if (!invoice) return fail("not-found");
  if (invoice.status !== "DRAFT") return fail("final");
  const { _count, _max } = await tx.invoiceLine.aggregate({ where: { invoiceId }, _count: true, _max: { position: true } });
  if (_count >= MAX_LINES) return fail("too-many-lines");
  const organizationId = await tenantId(tx);
  const created = await tx.invoiceLine.create({
    data: { organizationId, invoiceId, position: (_max.position ?? 0) + 1, ...lineData(line) },
    select: { id: true },
  });
  return ok(created.id);
}

export async function updateLine(tx: TenantTx, invoiceId: string, lineId: string, line: ParsedLine): Promise<Result> {
  const invoice = await lockInvoice(tx, invoiceId);
  if (!invoice || !UUID.test(lineId)) return fail("not-found");
  if (invoice.status !== "DRAFT") return fail("final");
  const { count } = await tx.invoiceLine.updateMany({ where: { id: lineId, invoiceId }, data: lineData(line) });
  return count === 1 ? ok(undefined) : fail("not-found");
}

export async function removeLine(tx: TenantTx, invoiceId: string, lineId: string): Promise<Result> {
  const invoice = await lockInvoice(tx, invoiceId);
  if (!invoice || !UUID.test(lineId)) return fail("not-found");
  if (invoice.status !== "DRAFT") return fail("final");
  const { count } = await tx.invoiceLine.deleteMany({ where: { id: lineId, invoiceId } });
  return count === 1 ? ok(undefined) : fail("not-found");
}

/** Deletes a draft and its lines. A finalized invoice can't be deleted (the trigger refuses): void it. */
export async function deleteDraft(tx: TenantTx, id: string): Promise<Result> {
  const invoice = await lockInvoice(tx, id);
  if (!invoice) return fail("not-found");
  if (invoice.status !== "DRAFT") return fail("final");
  await tx.invoice.delete({ where: { id } });
  return ok(undefined);
}

/**
 * Finalizes a draft: one UPDATE to OPEN, whose trigger assigns the next number, the issue time and the
 * totals. The due date is netDays after the database's current UTC date, computed in the same statement so
 * the application's clock plays no part.
 */
export async function finalize(tx: TenantTx, id: string, netDays: number): Promise<Result<number>> {
  if (!Number.isInteger(netDays) || netDays < 0 || netDays > 365) return fail("bad-terms");
  const invoice = await lockInvoice(tx, id);
  if (!invoice) return fail("not-found");
  if (invoice.status !== "DRAFT") return fail("final");
  if ((await tx.invoiceLine.count({ where: { invoiceId: id } })) === 0) return fail("no-lines");
  await tx.$executeRaw`
    UPDATE invoices SET status = 'OPEN', due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date + ${netDays}::int
    WHERE id = ${id}::uuid AND status = 'DRAFT'`;
  const row = await tx.invoice.findUniqueOrThrow({ where: { id }, select: { number: true } });
  return ok(row.number!);
}

async function transition(tx: TenantTx, id: string, to: "PAID" | "VOID"): Promise<Result> {
  if (!UUID.test(id)) return fail("not-found");
  const { count } = await tx.invoice.updateMany({ where: { id, status: "OPEN" }, data: { status: to } });
  if (count === 1) return ok(undefined);
  return (await tx.invoice.count({ where: { id } })) === 1 ? fail("not-open") : fail("not-found");
}

/** OPEN → PAID. (Day 3 records payments through Stripe; this is the manual path.) */
export const markPaid = (tx: TenantTx, id: string) => transition(tx, id, "PAID");

/** OPEN → VOID: the number stays used, the invoice no longer counts. */
export const voidInvoice = (tx: TenantTx, id: string) => transition(tx, id, "VOID");

/** The trigger codes (migrations/*_invoicing) as Result reasons, for callers that catch them. */
export const TRIGGER_REASONS: Record<string, string> = {
  TL002: "final",
  TL003: "not-open",
  TL004: "no-lines",
  TL005: "bad-terms",
  TL006: "final",
  TL007: "not-open",
  TL008: "final",
  TL009: "too-many-lines",
};

/**
 * Runs `fn`, turning a trigger's refusal into a Result. Wrap the whole `run(...)`, not a call inside it: the
 * refusal has aborted the transaction, and withTenant must see the error to roll back (a transaction that
 * caught it and returned would fail at COMMIT, by design).
 */
export async function refusals<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await fn();
  } catch (error) {
    const reason = TRIGGER_REASONS[sqlState(error) ?? ""];
    if (reason) return fail(reason);
    throw error;
  }
}
