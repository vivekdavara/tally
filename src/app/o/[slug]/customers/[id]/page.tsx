import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTenant } from "@/server/dal";
import { getCustomer } from "@/server/invoices/service";
import { ActionForm } from "../../../../components/action-form";
import { deleteCustomerAction, updateCustomerAction } from "../../actions";

export default async function CustomerPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { organization, run } = await requireTenant(slug);
  const customer = await run((tx) => getCustomer(tx, id));
  // Another organization's customer is invisible here: the same 404 as an id that doesn't exist.
  if (!customer) notFound();
  return (
    <section className="stack">
      <p className="muted">
        <Link href={`/o/${slug}`}>{organization.name}</Link> / <Link href={`/o/${slug}/customers`}>Customers</Link> /{" "}
        {customer.name}
      </p>
      <h1>{customer.name}</h1>
      <ActionForm
        action={updateCustomerAction.bind(null, slug, customer.id)}
        testId="edit-customer"
        fields={[
          { name: "name", label: "Name", required: true, defaultValue: customer.name },
          { name: "email", label: "Email", type: "email", required: true, defaultValue: customer.email },
          { name: "address", label: "Address (optional)", multiline: true, defaultValue: customer.address ?? "" },
        ]}
        submit="Save"
        pending="Saving…"
      />
      <ActionForm action={deleteCustomerAction.bind(null, slug, customer.id)} testId="delete-customer" submit="Delete customer" pending="Deleting…" danger />
    </section>
  );
}
