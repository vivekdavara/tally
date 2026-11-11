import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { requireUser } from "@/server/dal";
import { listMemberships } from "@/server/orgs/memberships";
import { SignOutButton } from "../sign-out-button";

export const metadata = { title: "Your organizations · Tally" };

export default async function OrganizationsPage() {
  const user = await requireUser();
  const memberships = await listMemberships(db(), user.id);
  if (memberships.length === 1) {
    redirect(`/o/${memberships[0]!.organization.slug}`);
  }
  return (
    <section className="stack">
      <h1>Your organizations</h1>
      {memberships.length === 0 ? (
        <p>You don&apos;t belong to any organization yet.</p>
      ) : (
        <ul>
          {memberships.map((m) => (
            <li key={m.organization.id}>
              <Link href={`/o/${m.organization.slug}`}>{m.organization.name}</Link>{" "}
              <span className="muted">({m.role.toLowerCase()})</span>
            </li>
          ))}
        </ul>
      )}
      <SignOutButton />
    </section>
  );
}
