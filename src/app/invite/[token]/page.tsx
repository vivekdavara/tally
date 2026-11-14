import { notFound } from "next/navigation";
import { requireUser, runForInvitation } from "@/server/dal";
import { formatDate } from "@/server/invoices/format";
import { findOpenInvitation, parseInvitationLink } from "@/server/orgs/members";
import { ActionForm } from "../../components/action-form";
import { acceptInvitationAction } from "./actions";

// /invite/<organization id>.<secret>: the link an owner or admin sends. The same 404 for a malformed link, a wrong
// secret, another organization's id, and an invitation that was used, revoked or has expired.
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser();
  const link = parseInvitationLink(token);
  if (!link) notFound();
  const invitation = await runForInvitation(link, (tx) => findOpenInvitation(tx, link));
  if (!invitation) notFound();
  return (
    <section className="stack">
      <h1>Join {invitation.organization.name}</h1>
      {invitation.email === user.email ? (
        <>
          <p>
            You&apos;re invited as {invitation.role === "ADMIN" ? "an" : "a"} {invitation.role.toLowerCase()}. The invitation expires{" "}
            {formatDate(invitation.expiresAt)}.
          </p>
          <ActionForm action={acceptInvitationAction.bind(null, token)} testId="accept-invitation" submit="Accept invitation" pending="Joining…" />
        </>
      ) : (
        <p data-testid="wrong-email">This invitation is for a different email address. Sign in with the address it was sent to.</p>
      )}
    </section>
  );
}

export const metadata = { title: "Invitation · Tally", robots: { index: false } };
