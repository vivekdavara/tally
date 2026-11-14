"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { email } from "@/server/auth/schemas";
import { billing } from "@/server/billing/runtime";
import { requireTenant } from "@/server/dal";
import { refusals } from "@/server/invoices/service";
import { changeRole, invite, removeMember, revokeInvitation } from "@/server/orgs/members";
import type { FormState } from "../../../actions";
import { guard } from "../guard";

// Server Actions for the members page (DESIGN.md, "Members and invitations"). Each needs "manage-members"
// (owners and admins); the services refuse what only an owner may do, against the role locked in run's
// transaction, and the database refuses leaving an organization without an owner.

const MESSAGES: Record<string, string> = {
  forbidden: "Only an owner can make, change or remove an owner.",
  "last-owner": "An organization needs at least one owner. Make someone else an owner first.",
  "already-member": "That person is already a member.",
  "invite-busy": "An invitation to this address was just created. Reload the page.",
  "not-found": "That no longer exists. Reload the page.",
};

const message = (result: { ok: false; reason: string }): FormState => ({ error: MESSAGES[result.reason] ?? "Something went wrong." });

const role = z.enum(["OWNER", "ADMIN", "MEMBER"], { message: "Choose a role." });
const inviteInput = z.object({ email, role });

const text = (formData: FormData, name: string) => (typeof formData.get(name) === "string" ? (formData.get(name) as string) : "");

export async function inviteAction(slug: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const values = { email: text(formData, "email"), role: text(formData, "role") };
    const parsed = inviteInput.safeParse(values);
    if (!parsed.success) return { fieldErrors: z.flattenError(parsed.error).fieldErrors, values };
    const { run, user } = await requireTenant(slug, "manage-members");
    const result = await refusals(() => run((tx) => invite(tx, user.id, parsed.data.email, parsed.data.role)));
    if (!result.ok) return { ...message(result), values };
    revalidatePath(`/o/${slug}/members`);
    // Shown once: only its digest is stored. Sending it is the inviter's job (Tally sends no email for this yet).
    return { notice: `${billing().config.appBaseUrl}/invite/${result.value.token}` };
  });
}

export async function changeRoleAction(slug: string, userId: string, _state: FormState, formData: FormData): Promise<FormState> {
  return guard(async () => {
    const parsed = role.safeParse(text(formData, "role"));
    if (!parsed.success) return { fieldErrors: { role: ["Choose a role."] } };
    const { run, user } = await requireTenant(slug, "manage-members");
    const result = await refusals(() => run((tx) => changeRole(tx, user.id, userId, parsed.data)));
    if (!result.ok) return message(result);
    revalidatePath(`/o/${slug}/members`);
    return {};
  });
}

export async function removeMemberAction(slug: string, userId: string): Promise<FormState> {
  return guard(async () => {
    const { run, user } = await requireTenant(slug, "manage-members");
    const result = await refusals(() => run((tx) => removeMember(tx, user.id, userId)));
    if (!result.ok) return message(result);
    revalidatePath(`/o/${slug}/members`);
    return {};
  });
}

export async function revokeInvitationAction(slug: string, id: string): Promise<FormState> {
  return guard(async () => {
    const { run } = await requireTenant(slug, "manage-members");
    const result = await refusals(() => run((tx) => revokeInvitation(tx, id)));
    if (!result.ok) return message(result);
    revalidatePath(`/o/${slug}/members`);
    return {};
  });
}
