import { notFound } from "next/navigation";
import { mockProvider } from "@/server/billing/runtime";
import { formatMoney } from "@/server/invoices/money";
import { ActionForm } from "../../components/action-form";
import { lapseAction, payByBankAction, payByCardAction, redeliverAction, settleAction } from "../actions";

// The mock provider's hosted checkout page: what the customer would see on Stripe, plus the controls a test needs
// (a bank debit that settles or fails, a session left to expire, a redelivered event). A 404 unless billing runs
// on the mock, and for any session id the mock didn't issue (they're 128-bit random, like Stripe's).

export const dynamic = "force-dynamic";

export default async function MockCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = mockProvider()?.session(id);
  if (!session) notFound();
  const { request } = session;
  const processing = session.status === "complete" && session.paymentStatus === "unpaid";
  return (
    <section className="stack">
      <p className="muted">Mock checkout (no real payment is made)</p>
      <h1>{request.description}</h1>
      <p>
        <strong data-testid="checkout-amount">{formatMoney(request.amountMinor, request.currency)}</strong>, billed to {request.customerEmail}
      </p>
      <p data-testid="checkout-status">
        Session {session.status}, payment {session.paymentStatus}
      </p>
      {session.status === "open" ? (
        <div className="row">
          <ActionForm action={payByCardAction.bind(null, id)} testId="pay-card" submit="Pay by card" pending="Paying…" />
          <ActionForm action={payByBankAction.bind(null, id)} testId="pay-bank" submit="Pay by bank debit" pending="Submitting…" />
          <ActionForm action={lapseAction.bind(null, id)} testId="lapse" submit="Let it expire" pending="…" danger />
        </div>
      ) : null}
      {processing ? (
        <div className="row">
          <ActionForm action={settleAction.bind(null, id, true)} testId="settle-ok" submit="Bank debit settles" pending="…" />
          <ActionForm action={settleAction.bind(null, id, false)} testId="settle-fail" submit="Bank debit fails" pending="…" danger />
        </div>
      ) : null}
      {session.deliveries.length > 0 ? (
        <>
          <h2>Webhook deliveries</h2>
          <ol data-testid="deliveries">
            {session.deliveries.map((d, i) => (
              <li key={i}>
                <code>{d.type}</code> ({d.eventId}): {JSON.stringify(d.answer)}
              </li>
            ))}
          </ol>
          <ActionForm action={redeliverAction.bind(null, id)} testId="redeliver" submit="Send the last event again" pending="…" />
        </>
      ) : null}
      {session.status !== "open" ? (
        <p>
          <a href="/paid?status=success">Return to the merchant</a>
        </p>
      ) : null}
    </section>
  );
}
