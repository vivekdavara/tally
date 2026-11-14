import type { Role } from "@/generated/prisma/client";
import { signUpInput } from "@/server/auth/schemas";
import { signUp } from "@/server/auth/signup";
import { db } from "@/server/db/client";
import { withTenant, type TenantTx } from "@/server/db/tenant";
import { addLine, createCustomer, createDraft, finalize } from "@/server/invoices/service";
import type { FormState } from "@/app/actions";
import { unique } from "../helpers";

// Organizations with one user in each role, made through the application's own sign-up and services (on db(), the
// client the Server Actions use), for tests that call pages and actions as each kind of member.

export interface Person {
  userId: string;
  email: string;
  /** Their own organization, from sign-up (each user signs up with one). */
  ownSlug: string;
}

export interface World {
  slug: string;
  organizationId: string;
  name: string;
  owner: Person;
  admin: Person;
  member: Person;
  run<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  customerId: string;
}

export async function person(prefix = "user"): Promise<Person> {
  const u = unique();
  const email = `${prefix}-${u}@example.com`;
  const result = await signUp(signUpInput.parse({ name: `${prefix} ${u}`, email, password: "long enough!", organizationName: `${prefix} org ${u}` }));
  if (!result.ok) throw new Error("sign-up failed");
  return { userId: result.userId, email, ownSlug: result.slug };
}

/** Adds `user` to the organization with `role`, as an owner's invitation would. */
export async function addMember(organizationId: string, userId: string, role: Role): Promise<void> {
  await withTenant(organizationId, (tx) => tx.membership.create({ data: { organizationId, userId, role } }));
}

/** A new organization (its owner signed it up) with an admin, a member and one customer. */
export async function world(prefix = "w"): Promise<World> {
  const u = unique();
  const name = `${prefix} ${u}`;
  const email = `${prefix}-owner-${u}@example.com`;
  const signed = await signUp(signUpInput.parse({ name: `Owner ${u}`, email, password: "long enough!", organizationName: name }));
  if (!signed.ok) throw new Error("sign-up failed");
  const [admin, member] = await Promise.all([person(`${prefix}-admin`), person(`${prefix}-member`)]);
  await addMember(signed.organizationId, admin.userId, "ADMIN");
  await addMember(signed.organizationId, member.userId, "MEMBER");
  const run = <T,>(fn: (tx: TenantTx) => Promise<T>) => withTenant(signed.organizationId, fn);
  const customer = await run((tx) => createCustomer(tx, { name: "Customer", email: `c-${u}@example.com`, address: null }));
  if (!customer.ok) throw new Error(customer.reason);
  return {
    slug: signed.slug,
    organizationId: signed.organizationId,
    name,
    owner: { userId: signed.userId, email, ownSlug: signed.slug },
    admin,
    member,
    run,
    customerId: customer.value,
  };
}

const value = <T,>(result: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.value;
};

/** A draft of 10.00 USD with one line; returns its id and the line's. */
export async function draft(w: World): Promise<{ invoiceId: string; lineId: string }> {
  return w.run(async (tx) => {
    const invoiceId = value(await createDraft(tx, { customerId: w.customerId, currency: "USD", memo: null }));
    const lineId = value(await addLine(tx, invoiceId, { description: "Work", quantity: 1000n, unitPriceMinor: 1000n, taxRate: 0n }));
    return { invoiceId, lineId };
  });
}

/** An open (finalized) invoice of 10.00 USD due in `netDays`. */
export async function openInvoice(w: World, netDays = 30): Promise<string> {
  const { invoiceId } = await draft(w);
  await w.run(async (tx) => value(await finalize(tx, invoiceId, netDays)));
  return invoiceId;
}

/** What a Server Action or page did: returned a form state, redirected, or answered 404. */
export type Outcome = { state: FormState } | { redirect: string } | { notFound: true } | { value: unknown };

export async function outcome(promise: Promise<unknown>): Promise<Outcome> {
  try {
    const result = await promise;
    if (result && typeof result === "object" && !("$$typeof" in result) && !(result instanceof Response)) return { state: result as FormState };
    return { value: result };
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest === "NEXT_HTTP_ERROR_FALLBACK;404") return { notFound: true };
    const redirect = /^NEXT_REDIRECT;[a-z]+;([^;]+);/.exec(digest);
    if (redirect) return { redirect: redirect[1]! };
    throw error;
  }
}

export function formData(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [name, v] of Object.entries(fields)) data.set(name, v);
  return data;
}

/** The session the mocked auth() returns, set per call. */
export const sessions = { current: null as null | { user: { id: string } } };

export function signInAs(p: Person | null): void {
  sessions.current = p ? { user: { id: p.userId } } : null;
}

export { db };
