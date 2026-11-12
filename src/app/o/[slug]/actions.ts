"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireTenant } from "@/server/dal";
import { customerInput, draftInput, draftUpdateInput, finalizeInput, parseLine } from "@/server/invoices/schemas";
import {
  addLine,
  createCustomer,
  createDraft,
  deleteCustomer,
  deleteDraft,
  finalize,
  invoiceCurrency,
  markPaid,
  refusals,
  removeLine,
  updateCustomer,
  updateDraft,
  voidInvoice,
  type Result,
} from "@/server/invoices/service";
import type { TenantTx } from "@/server/db/tenant";
import type { FormState } from "../../actions";

// Server Actions for customers and invoices. Each starts with requireTenant(slug): the membership check (a 404
// for anyone who isn't a member) and the transaction bound to that organization. The slug and ids are bound
// into the action by the page, so a client can change them, and that's fine: a slug they aren't a member of
// is a 404, and an id from another organization is invisible under row-level security ("not found").

const MESSAGES: Record<string, string> = {
  "email-taken": "A customer with this email already exists.",
  "has-invoices": "This customer has invoices, so it can't be deleted.",
  "no-customer": "Choose a customer from the list.",
  "not-found": "That no longer exists. Reload the page.",
  final: "This invoice is final and can't be changed. Void it instead.",
  "not-open": "Only an open invoice can be marked paid or voided.",
  "no-lines": "Add at least one line before finalizing.",
  "too-many-lines": "An invoice can have at most 100 lines.",
  "bad-terms": "Use payment terms of 0 to 365 days.",
};

const message = (result: { ok: false; reason: string }): FormState => ({ error: MESSAGES[result.reason] ?? "Something went wrong." });

function fields(formData: FormData, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, typeof formData.get(name) === "string" ? (formData.get(name) as string) : ""]));
}

const invoicePath = (slug: string, id: string) => `/o/${slug}/invoices/${id}`;

// Customers ---------------------------------------------------------------------------------------------------

export async function createCustomerAction(slug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["name", "email", "address"]);
  const parsed = customerInput.safeParse(values);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  const { run } = await requireTenant(slug);
  const result = await refusals(() => run((tx) => createCustomer(tx, parsed.data)));
  if (!result.ok) return { ...message(result), values };
  revalidatePath(`/o/${slug}/customers`);
  return {};
}

export async function updateCustomerAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["name", "email", "address"]);
  const parsed = customerInput.safeParse(values);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  const { run } = await requireTenant(slug);
  const result = await refusals(() => run((tx) => updateCustomer(tx, id, parsed.data)));
  if (!result.ok) return { ...message(result), values };
  redirect(`/o/${slug}/customers`);
}

export async function deleteCustomerAction(slug: string, id: string): Promise<FormState> {
  const { run } = await requireTenant(slug);
  const result = await run((tx) => deleteCustomer(tx, id));
  if (!result.ok) return message(result);
  redirect(`/o/${slug}/customers`);
}

// Invoices ----------------------------------------------------------------------------------------------------

export async function createDraftAction(slug: string, _state: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["customerId", "currency", "memo"]);
  const parsed = draftInput.safeParse(values);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  const { run } = await requireTenant(slug);
  const result = await run((tx) => createDraft(tx, parsed.data));
  if (!result.ok) return { ...message(result), values };
  redirect(invoicePath(slug, result.value));
}

export async function updateDraftAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["customerId", "memo"]);
  const parsed = draftUpdateInput.safeParse(values);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  const { run } = await requireTenant(slug);
  const result = await refusals(() => run((tx) => updateDraft(tx, id, parsed.data)));
  if (!result.ok) return { ...message(result), values };
  revalidatePath(invoicePath(slug, id));
  return {};
}

export async function addLineAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["description", "quantity", "unitPrice", "taxRate"]);
  const { run } = await requireTenant(slug);
  // The currency never changes after creation, so parsing against it outside the write's transaction is safe.
  const currency = await run((tx) => invoiceCurrency(tx, id));
  if (!currency) return { error: MESSAGES["not-found"], values };
  const parsed = parseLine(values, currency);
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors, values };
  const result = await refusals(() => run((tx) => addLine(tx, id, parsed.line)));
  if (!result.ok) return { ...message(result), values };
  revalidatePath(invoicePath(slug, id));
  return {};
}

async function invoiceAction(slug: string, id: string, fn: (tx: TenantTx) => Promise<Result<unknown>>): Promise<FormState> {
  const { run } = await requireTenant(slug);
  const result = await refusals(() => run(fn));
  if (!result.ok) return message(result);
  revalidatePath(invoicePath(slug, id));
  return {};
}

export async function removeLineAction(slug: string, id: string, lineId: string): Promise<FormState> {
  return invoiceAction(slug, id, (tx) => removeLine(tx, id, lineId));
}

export async function finalizeAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  const values = fields(formData, ["netDays"]);
  const parsed = finalizeInput.safeParse(values);
  if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
  return invoiceAction(slug, id, (tx) => finalize(tx, id, parsed.data.netDays));
}

export async function markPaidAction(slug: string, id: string): Promise<FormState> {
  return invoiceAction(slug, id, (tx) => markPaid(tx, id));
}

export async function voidAction(slug: string, id: string): Promise<FormState> {
  return invoiceAction(slug, id, (tx) => voidInvoice(tx, id));
}

export async function deleteDraftAction(slug: string, id: string): Promise<FormState> {
  const { run } = await requireTenant(slug);
  const result = await refusals(() => run((tx) => deleteDraft(tx, id)));
  if (!result.ok) return message(result);
  redirect(`/o/${slug}/invoices`);
}
