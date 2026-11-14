import Link from "next/link";
import { notFound } from "next/navigation";
import { listPayments } from "@/server/billing/service";
import { requireTenant } from "@/server/dal";
import { formatDate, invoiceLabel, STATUS_LABELS } from "@/server/invoices/format";
import { formatMoney, formatQuantity, formatTaxRate, toMajorString } from "@/server/invoices/money";
import { getInvoice, listCustomers } from "@/server/invoices/service";
import { ActionForm } from "../../../../components/action-form";
import {
  addLineAction,
  collectPaymentAction,
  deleteDraftAction,
  finalizeAction,
  markPaidAction,
  removeLineAction,
  updateDraftAction,
  voidAction,
} from "../../actions";

const PAYMENT_LABELS = {
  PENDING: "Waiting for payment",
  PROCESSING: "Processing (bank debit)",
  SUCCEEDED: "Paid",
  FAILED: "Failed",
  EXPIRED: "Expired",
} as const;

export default async function InvoicePage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  const { organization, run, can } = await requireTenant(slug, "view");
  const { invoice, customers, payments } = await run(async (tx) => ({
    invoice: await getInvoice(tx, id),
    customers: await listCustomers(tx),
    payments: await listPayments(tx, id),
  }));
  if (!invoice) notFound();
  const money = (minor: bigint) => formatMoney(minor, invoice.currency);
  const draft = invoice.status === "DRAFT";
  return (
    <section className="stack wide">
      <p className="muted">
        <Link href={`/o/${slug}`}>{organization.name}</Link> / <Link href={`/o/${slug}/invoices`}>Invoices</Link> /{" "}
        {invoiceLabel(invoice.number)}
      </p>
      <h1 data-testid="invoice-title">
        {invoiceLabel(invoice.number)} <span className="badge">{STATUS_LABELS[invoice.status]}</span>
      </h1>
      <p>
        To <strong>{invoice.customer.name}</strong> ({invoice.customer.email}), in {invoice.currency}.
        {invoice.issuedAt ? ` Issued ${formatDate(invoice.issuedAt)}.` : ""}
        {invoice.dueOn ? ` Due ${formatDate(invoice.dueOn)}.` : ""}
      </p>
      {invoice.memo ? <p className="memo">{invoice.memo}</p> : null}

      <table data-testid="lines">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Tax</th>
            <th className="num">Amount</th>
            {draft ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.description}</td>
              <td className="num">{formatQuantity(line.quantity)}</td>
              <td className="num">{money(line.unitPriceMinor)}</td>
              <td className="num">{formatTaxRate(line.taxRate)}%</td>
              <td className="num">{money(line.amount)}</td>
              {draft ? (
                <td>
                  <ActionForm action={removeLineAction.bind(null, slug, invoice.id, line.id)} submit="Remove" pending="…" className="inline" />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4}>Subtotal</td>
            <td className="num" data-testid="subtotal">
              {money(invoice.totals.subtotal)}
            </td>
          </tr>
          {invoice.totals.taxes.map((group) => (
            <tr key={group.rate.toString()}>
              <td colSpan={4}>
                Tax {formatTaxRate(group.rate)}% on {money(group.base)}
              </td>
              <td className="num">{money(group.tax)}</td>
            </tr>
          ))}
          <tr className="total">
            <td colSpan={4}>Total</td>
            <td className="num" data-testid="total">
              {money(invoice.totals.total)}
            </td>
          </tr>
        </tfoot>
      </table>

      <p>
        <a href={`/o/${slug}/invoices/${invoice.id}/pdf`} data-testid="pdf-link">
          {draft ? "Preview PDF" : "Download PDF"}
        </a>
      </p>

      {draft ? (
        <>
          <h2>Add a line</h2>
          <ActionForm
            action={addLineAction.bind(null, slug, invoice.id)}
            testId="add-line"
            className="stack grid"
            fields={[
              { name: "description", label: "Description", required: true },
              { name: "quantity", label: "Quantity", inputMode: "decimal", defaultValue: "1" },
              { name: "unitPrice", label: `Unit price (${invoice.currency})`, inputMode: "decimal", placeholder: toMajorString(0n, invoice.currency) },
              { name: "taxRate", label: "Tax rate (%)", inputMode: "decimal", defaultValue: "0" },
            ]}
            submit="Add line"
            pending="Adding…"
          />
          <h2>Details</h2>
          <ActionForm
            action={updateDraftAction.bind(null, slug, invoice.id)}
            testId="draft-details"
            fields={[
              {
                name: "customerId",
                label: "Customer",
                defaultValue: invoice.customer.id,
                options: customers.map((c) => ({ value: c.id, label: `${c.name} (${c.email})` })),
              },
              { name: "memo", label: "Memo", multiline: true, defaultValue: invoice.memo ?? "" },
            ]}
            submit="Save details"
            pending="Saving…"
          />
          <h2>Finalize</h2>
          <p className="muted">Finalizing gives the invoice its number and fixes its lines and totals. It can then only be paid or voided.</p>
          {can("finalize") ? (
            <ActionForm
              action={finalizeAction.bind(null, slug, invoice.id)}
              testId="finalize"
              fields={[{ name: "netDays", label: "Payment due in (days)", type: "number", inputMode: "numeric", defaultValue: "30" }]}
              submit="Finalize invoice"
              pending="Finalizing…"
            />
          ) : (
            <p data-testid="finalize-needs-role">An owner or an admin finalizes invoices.</p>
          )}
          <ActionForm action={deleteDraftAction.bind(null, slug, invoice.id)} testId="delete-draft" submit="Delete draft" pending="Deleting…" danger />
        </>
      ) : invoice.status === "OPEN" ? (
        <>
          <h2>Payment</h2>
          <p className="muted">
            A payment link opens a hosted checkout page for {money(invoice.totals.total)}; send it to the customer. The invoice is
            marked paid when the payment provider confirms the payment.
          </p>
          {can("collect-payment") || can("mark-paid") || can("void") ? (
            <div className="row">
              {can("collect-payment") ? (
                <ActionForm action={collectPaymentAction.bind(null, slug, invoice.id)} testId="collect-payment" submit="Create payment link" pending="Creating…" />
              ) : null}
              {can("mark-paid") ? (
                <ActionForm action={markPaidAction.bind(null, slug, invoice.id)} testId="mark-paid" submit="Mark paid" pending="Saving…" />
              ) : null}
              {can("void") ? <ActionForm action={voidAction.bind(null, slug, invoice.id)} testId="void" submit="Void invoice" pending="Voiding…" danger /> : null}
            </div>
          ) : (
            <p data-testid="payment-needs-role">An owner or an admin creates payment links, marks invoices paid and voids them.</p>
          )}
        </>
      ) : null}

      {payments.length > 0 ? (
        <>
          <h2>Payment attempts</h2>
          <table data-testid="payments">
            <thead>
              <tr>
                <th>Created</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} data-status={p.status}>
                  <td>{formatDate(p.createdAt)}</td>
                  <td>
                    {PAYMENT_LABELS[p.status]}
                    {p.paidAt ? ` ${formatDate(p.paidAt)}` : ""}
                    {p.refundDue ? (
                      <>
                        {" "}
                        <span className="badge" data-testid="refund-due">
                          Refund due
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td className="num">{money(p.amountMinor)}</td>
                  <td>
                    {p.status === "PENDING" ? (
                      <a href={p.checkoutUrl} data-testid="checkout-link" rel="noreferrer">
                        Payment link
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
