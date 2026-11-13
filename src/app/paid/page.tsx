// Where checkout sends the customer back (the session's success and cancel URLs). Public: the customer has no
// Tally account. It says nothing about the invoice; the payment is applied by the webhook, not by this page.

export default async function PaidPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  return (
    <section className="stack">
      {status === "canceled" ? (
        <>
          <h1>Payment canceled</h1>
          <p>No payment was made. You can use the payment link again until it expires.</p>
        </>
      ) : (
        <>
          <h1>Thank you</h1>
          <p>Your payment is being processed. The business you paid will see it on the invoice shortly.</p>
        </>
      )}
    </section>
  );
}
