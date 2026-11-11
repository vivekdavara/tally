import Link from "next/link";
import { requireMembership, requireTenant } from "@/server/dal";
import { SignOutButton } from "../../sign-out-button";

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // `run` is bound to the organization the membership check found; the page never handles its id.
  const { organization, role, user, run } = await requireTenant(slug);
  const counts = await run(async (tx) => ({
    customers: await tx.customer.count(),
    invoices: await tx.invoice.count(),
  }));
  return (
    <section className="stack">
      <p className="muted">
        <Link href="/o">Organizations</Link> / {organization.name}
      </p>
      <h1>{organization.name}</h1>
      <p>
        Signed in as {user.name} ({user.email}), {role.toLowerCase()}.
      </p>
      <dl className="row">
        <div>
          <dt>Customers</dt>
          <dd data-testid="customer-count">{counts.customers}</dd>
        </div>
        <div>
          <dt>Invoices</dt>
          <dd data-testid="invoice-count">{counts.invoices}</dd>
        </div>
      </dl>
      <SignOutButton />
    </section>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization } = await requireMembership(slug);
  return { title: `${organization.name} · Tally` };
}
