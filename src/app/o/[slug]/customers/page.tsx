import Link from "next/link";
import { requireMembership, requireTenant } from "@/server/dal";
import { listCustomers } from "@/server/invoices/service";
import { ActionForm } from "../../../components/action-form";
import { createCustomerAction } from "../actions";

export default async function CustomersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization, run } = await requireTenant(slug);
  const customers = await run((tx) => listCustomers(tx));
  return (
    <section className="stack">
      <p className="muted">
        <Link href={`/o/${slug}`}>{organization.name}</Link> / Customers
      </p>
      <h1>Customers</h1>
      {customers.length === 0 ? (
        <p className="muted">No customers yet.</p>
      ) : (
        <table data-testid="customers">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/o/${slug}/customers/${c.id}`}>{c.name}</Link>
                </td>
                <td>{c.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>New customer</h2>
      <ActionForm
        action={createCustomerAction.bind(null, slug)}
        testId="new-customer"
        fields={[
          { name: "name", label: "Name", required: true },
          { name: "email", label: "Email", type: "email", required: true },
          { name: "address", label: "Address (optional)", multiline: true },
        ]}
        submit="Add customer"
        pending="Adding…"
      />
    </section>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization } = await requireMembership(slug);
  return { title: `Customers · ${organization.name} · Tally` };
}
