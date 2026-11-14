"use server";

import { redirect } from "next/navigation";
import { requireUser, runForInvitation } from "@/server/dal";
import { refusals } from "@/server/invoices/service";
import { acceptInvitation, parseInvitationLink } from "@/server/orgs/members";
import type { FormState } from "../../actions";

const MESSAGES: Record<string, string> = {
  invalid: "This invitation link isn't valid any more.",
  "invitation-closed": "This invitation link isn't valid any more.",
  "wrong-email": "This invitation is for a different email address. Sign in with the address it was sent to.",
};

/** Joins the organization the link invites to, as the signed-in user, and goes there. */
export async function acceptInvitationAction(token: string): Promise<FormState> {
  const user = await requireUser();
  const link = parseInvitationLink(token);
  if (!link) return { error: MESSAGES.invalid };
  const result = await refusals(() => runForInvitation(link, (tx) => acceptInvitation(tx, link, user)));
  if (!result.ok) return { error: MESSAGES[result.reason] ?? "Something went wrong." };
  redirect(`/o/${result.value.slug}`);
}
