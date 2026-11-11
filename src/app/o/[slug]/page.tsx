import Link from "next/link";
import { requireMembership } from "@/server/dal";
import { withTenant } from "@/server/db/tenant";
import { SignOutButton } from "../../sign-out-button";

export default async function OrganizationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization, role, user } = await requireMembership(slug);
  // The tenant id comes from the membership check, never from the URL.
  const counts = await withTenant(organization.id, async (tx) => ({
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
