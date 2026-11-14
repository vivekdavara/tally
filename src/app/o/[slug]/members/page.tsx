import Link from "next/link";
import { requireMembership, requireTenant } from "@/server/dal";
import { formatDate } from "@/server/invoices/format";
import { listMembers, listOpenInvitations } from "@/server/orgs/members";
import { ActionForm } from "../../../components/action-form";
import { changeRoleAction, inviteAction, removeMemberAction, revokeInvitationAction } from "./actions";

const ROLE_OPTIONS = [
  { value: "MEMBER", label: "Member" },
  { value: "ADMIN", label: "Admin" },
  { value: "OWNER", label: "Owner" },
];

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization, user, run, can } = await requireTenant(slug, "view");
  const { members, invitations } = await run(async (tx) => ({ members: await listMembers(tx), invitations: await listOpenInvitations(tx) }));
  const manager = can("manage-members");
  // What the page offers; the actions check again (an admin can't change or remove an owner, or make one).
  const mayChange = (role: string) => can(role === "OWNER" ? "manage-owners" : "manage-members");
  const options = can("manage-owners") ? ROLE_OPTIONS : ROLE_OPTIONS.filter((o) => o.value !== "OWNER");
  return (
    <section className="stack wide">
      <p className="muted">
        <Link href={`/o/${slug}`}>{organization.name}</Link> / Members
      </p>
      <h1>Members</h1>
      <table data-testid="members">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Since</th>
            {manager ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.userId} data-email={m.email} data-role={m.role}>
              <td>
                {m.name}
                {m.userId === user.id ? " (you)" : ""}
              </td>
              <td>{m.email}</td>
              <td>
                {manager && mayChange(m.role) ? (
                  <ActionForm
                    action={changeRoleAction.bind(null, slug, m.userId)}
                    testId={`role-${m.email}`}
                    className="inline"
                    fields={[{ name: "role", label: "Role", defaultValue: m.role, options }]}
                    submit="Change"
                    pending="…"
                  />
                ) : (
                  m.role.toLowerCase()
                )}
              </td>
              <td>{formatDate(m.since)}</td>
              {manager ? (
                <td>
                  {mayChange(m.role) ? (
                    <ActionForm action={removeMemberAction.bind(null, slug, m.userId)} testId={`remove-${m.email}`} className="inline" submit="Remove" pending="…" danger />
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>

      {manager ? (
        <>
          <h2>Invite someone</h2>
          <p className="muted">
            Tally shows the invitation link once; send it to them. It works for seven days, only for an account with that email address.
          </p>
          <ActionForm
            action={inviteAction.bind(null, slug)}
            testId="invite"
            fields={[
              { name: "email", label: "Email", type: "email", required: true },
              { name: "role", label: "Role", defaultValue: "MEMBER", options },
            ]}
            submit="Create invitation link"
            pending="Creating…"
          />
          {invitations.length > 0 ? (
            <>
              <h2>Open invitations</h2>
              <table data-testid="invitations">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <tr key={i.id} data-email={i.email}>
                      <td>{i.email}</td>
                      <td>{i.role.toLowerCase()}</td>
                      <td>{formatDate(i.expiresAt)}</td>
                      <td>
                        <ActionForm action={revokeInvitationAction.bind(null, slug, i.id)} testId={`revoke-${i.email}`} className="inline" submit="Revoke" pending="…" danger />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </>
      ) : (
        <p className="muted" data-testid="members-needs-role">
          An owner or an admin invites people and changes roles.
        </p>
      )}
    </section>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { organization } = await requireMembership(slug);
  return { title: `Members · ${organization.name} · Tally` };
}
