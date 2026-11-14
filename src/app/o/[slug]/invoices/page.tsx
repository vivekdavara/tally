import Link from "next/link";
import { requireMembership, requireTenant } from "@/server/dal";
import { formatDate, invoiceLabel, STATUS_LABELS } from "@/server/invoices/format";
import { CURRENCIES, formatMoney } from "@/server/invoices/money";
import { listCustomers, listInvoices } from "@/server/invoices/service";
import { ActionForm } from "../../../components/action-form";
import { createDraftAction } from "../actions";

export default async function InvoicesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization, run } = await requireTenant(slug, "view");
  const { invoices, customers } = await run(async (tx) => ({ invoices: await listInvoices(tx), customers: await listCustomers(tx) }));
  return (
    <section className="stack">
      <p className="muted">
        <Link href={`/o/${slug}`}>{organization.name}</Link> / Invoices
      </p>
      <h1>Invoices</h1>
      {invoices.length === 0 ? (
        <p className="muted">No invoices yet.</p>
      ) : (
        <table data-testid="invoices">
          <thead>
            <tr>
              <th>Number</th>
              <th>Customer</th>
              <th>Status</th>
              <th>Due</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id}>
                <td>
                  <Link href={`/o/${slug}/invoices/${i.id}`}>{invoiceLabel(i.number)}</Link>
                </td>
                <td>{i.customerName}</td>
                <td>{STATUS_LABELS[i.status]}</td>
                <td>{i.dueOn ? formatDate(i.dueOn) : ""}</td>
                <td className="num">{formatMoney(i.total, i.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>New invoice</h2>
      {customers.length === 0 ? (
        <p>
          <Link href={`/o/${slug}/customers`}>Add a customer</Link> first.
        </p>
      ) : (
        <ActionForm
          action={createDraftAction.bind(null, slug)}
          testId="new-invoice"
          fields={[
            { name: "customerId", label: "Customer", options: customers.map((c) => ({ value: c.id, label: `${c.name} (${c.email})` })) },
            { name: "currency", label: "Currency", options: Object.keys(CURRENCIES).map((code) => ({ value: code, label: code })) },
            { name: "memo", label: "Memo (optional)", multiline: true },
          ]}
          submit="Create draft"
          pending="Creating…"
        />
      )}
    </section>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization } = await requireMembership(slug);
  return { title: `Invoices · ${organization.name} · Tally` };
}
