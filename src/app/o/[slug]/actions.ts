"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { billing } from "@/server/billing/runtime";
import { expirePendingCheckouts, startCheckout } from "@/server/billing/service";
import { requireTenant } from "@/server/dal";
import type { Permission } from "@/server/orgs/permissions";
import { customerInput, draftInput, draftUpdateInput, finalizeInput, parseLine } from "@/server/invoices/schemas";
import {
  addLine,
  CUSTOMER_GONE,
  CUSTOMER_HAS_INVOICES,
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
import { guard } from "./guard";

// Server Actions for customers and invoices. Each starts with requireTenant(slug, permission): the membership check (a 404
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
  "amount-too-small": "This invoice is below the smallest amount the payment provider can charge in its currency.",
  "amount-too-large": "This invoice is above the largest amount the payment provider can charge in one payment.",
  "currency-not-chargeable": "Card payment isn't available for this currency.",
  "checkout-expiring": "The last payment link expired a moment ago. Try again in a few minutes.",
  "checkout-busy": "Another payment link was just created for this invoice. Reload the page.",
  "provider-unavailable": "The payment provider didn't answer. Try again.",
  "provider-error": "The payment provider refused the request.",
};

const message = (result: { ok: false; reason: string }): FormState => ({ error: MESSAGES[result.reason] ?? "Something went wrong." });

function fields(formData: FormData, names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((name) => [name, typeof formData.get(name) === "string" ? (formData.get(name) as string) : ""]));
}

const invoicePath = (slug: string, id: string) => `/o/${slug}/invoices/${id}`;

// Customers ---------------------------------------------------------------------------------------------------

export async function createCustomerAction(slug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = fields(formData, ["name", "email", "address"]);
    const parsed = customerInput.safeParse(values);
    if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
    const { run } = await requireTenant(slug, "edit-customers");
    const result = await refusals(() => run((tx) => createCustomer(tx, parsed.data)));
    if (!result.ok) return { ...message(result), values };
    revalidatePath(`/o/${slug}/customers`);
    return {};
  });
}

export async function updateCustomerAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = fields(formData, ["name", "email", "address"]);
    const parsed = customerInput.safeParse(values);
    if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
    const { run } = await requireTenant(slug, "edit-customers");
    const result = await refusals(() => run((tx) => updateCustomer(tx, id, parsed.data)));
    if (!result.ok) return { ...message(result), values };
    redirect(`/o/${slug}/customers`);
  });
}

export async function deleteCustomerAction(slug: string, id: string): Promise<FormState> {
  return guard(async () => {
    const { run } = await requireTenant(slug, "edit-customers");
    const result = await refusals(() => run((tx) => deleteCustomer(tx, id)), CUSTOMER_HAS_INVOICES);
    if (!result.ok) return message(result);
    redirect(`/o/${slug}/customers`);
  });
}

// Invoices ----------------------------------------------------------------------------------------------------

export async function createDraftAction(slug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = fields(formData, ["customerId", "currency", "memo"]);
    const parsed = draftInput.safeParse(values);
    if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
    const { run } = await requireTenant(slug, "edit-drafts");
    const result = await refusals(() => run((tx) => createDraft(tx, parsed.data)), CUSTOMER_GONE);
    if (!result.ok) return { ...message(result), values };
    redirect(invoicePath(slug, result.value));
  });
}

export async function updateDraftAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = fields(formData, ["customerId", "memo"]);
    const parsed = draftUpdateInput.safeParse(values);
    if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
    const { run } = await requireTenant(slug, "edit-drafts");
    const result = await refusals(() => run((tx) => updateDraft(tx, id, parsed.data)), CUSTOMER_GONE);
    if (!result.ok) return { ...message(result), values };
    revalidatePath(invoicePath(slug, id));
    return {};
  });
}

export async function addLineAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = fields(formData, ["description", "quantity", "unitPrice", "taxRate"]);
    const { run } = await requireTenant(slug, "edit-drafts");
    // The currency never changes after creation, so parsing against it outside the write's transaction is safe.
    const currency = await run((tx) => invoiceCurrency(tx, id));
    if (!currency) return { error: MESSAGES["not-found"], values };
    const parsed = parseLine(values, currency);
    if (!parsed.ok) return { fieldErrors: parsed.fieldErrors, values };
    const result = await refusals(() => run((tx) => addLine(tx, id, parsed.line)));
    if (!result.ok) return { ...message(result), values };
    revalidatePath(invoicePath(slug, id));
    return {};
  });
}

async function invoiceAction(
  slug: string,
  id: string,
  permission: Permission,
  fn: (tx: TenantTx) => Promise<Result<unknown>>,
): Promise<FormState> {
  const { run } = await requireTenant(slug, permission);
  const result = await refusals(() => run(fn));
  if (!result.ok) return message(result);
  revalidatePath(invoicePath(slug, id));
  return {};
}

export async function removeLineAction(slug: string, id: string, lineId: string): Promise<FormState> {
  return guard(async () => {
    return invoiceAction(slug, id, "edit-drafts", (tx) => removeLine(tx, id, lineId));
  });
}

export async function finalizeAction(slug: string, id: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = fields(formData, ["netDays"]);
    const parsed = finalizeInput.safeParse(values);
    if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
    return invoiceAction(slug, id, "finalize", (tx) => finalize(tx, id, parsed.data.netDays));
  });
}

/**
 * Paid by hand or voided: its pending payment links are expired at the provider afterwards, so the customer can't
 * pay them (a payment that gets through anyway is recorded with refund_due set).
 */
async function closeInvoice(
  slug: string,
  id: string,
  permission: Permission,
  fn: (tx: TenantTx) => Promise<Result<unknown>>,
): Promise<FormState> {
  const { run } = await requireTenant(slug, permission);
  const result = await refusals(() => run(fn));
  if (!result.ok) return message(result);
  // Best effort here (the invoice is already closed); failures are logged, and a link paid anyway is recorded with
  // refund_due set.
  await expirePendingCheckouts(run, id, billing().provider);
  revalidatePath(invoicePath(slug, id));
  return {};
}

export async function markPaidAction(slug: string, id: string): Promise<FormState> {
  return guard(async () => {
    return closeInvoice(slug, id, "mark-paid", (tx) => markPaid(tx, id));
  });
}

export async function voidAction(slug: string, id: string): Promise<FormState> {
  return guard(async () => {
    return closeInvoice(slug, id, "void", (tx) => voidInvoice(tx, id));
  });
}

/** A payment link for an open invoice: the live one, or a new checkout session for its total. */
export async function collectPaymentAction(slug: string, id: string): Promise<FormState> {
  return guard(async () => {
    const { run, organization } = await requireTenant(slug, "collect-payment");
    const { provider, config } = billing();
    const result = await startCheckout(run, id, { provider, appBaseUrl: config.appBaseUrl, organizationName: organization.name });
    if (!result.ok) return message(result);
    revalidatePath(invoicePath(slug, id));
    return {};
  });
}

export async function deleteDraftAction(slug: string, id: string): Promise<FormState> {
  return guard(async () => {
    const { run } = await requireTenant(slug, "edit-drafts");
    const result = await refusals(() => run((tx) => deleteDraft(tx, id)));
    if (!result.ok) return message(result);
    redirect(`/o/${slug}/invoices`);
  });
}
