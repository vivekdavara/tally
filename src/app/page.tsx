import Link from "next/link";

export default function Home() {
  return (
    <section className="stack">
      <h1>Tally</h1>
      <p>Invoices for your customers, kept separate from every other business that uses Tally.</p>
      <p className="row">
        <Link className="button" href="/signup">
          Create an organization
        </Link>
        <Link href="/signin">Sign in</Link>
      </p>
    </section>
  );
}
