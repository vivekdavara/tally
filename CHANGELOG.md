# Changelog

## 1.0.0 (2026-11-15)

The first release: five days of work, one milestone a day (DESIGN.md, "Scope by day").

### Tenants and accounts (day 1)
- Organizations, users and memberships; sign-up creates a user and an organization in one transaction, sign-in with
  Auth.js credentials (scrypt passwords, a dummy hash so timing doesn't reveal which emails exist).
- Tenant isolation in three layers: every tenant route resolves a membership first (404 otherwise), tenant data is
  reached only through `withTenant` (one transaction, transaction-local tenant setting), and Postgres row-level
  security, forced on every tenant table, for a role that is not a superuser, has no `BYPASSRLS` and owns nothing.
  Composite foreign keys make cross-tenant references impossible to store; grants are column by column.
- The server refuses to start (exit 1) when its database role isn't bound by row-level security; `/api/health`
  answers 503 in the same case.

### Invoices (day 2)
- Customers; invoices with line items, per-rate taxes and totals in exact integer arithmetic, one rounding rule
  implemented in TypeScript and in SQL and kept equal by a differential test.
- Gapless invoice numbers per organization, even with concurrent finalizations and rollbacks.
- The life cycle (draft, open, paid, void) enforced by triggers for every writer; bill-to details copied at
  finalization; invoice PDFs from a small hand-written PDF writer.

### Billing (day 3)
- Payment links for open invoices through a provider interface: a Stripe-like mock by default, Stripe's test mode
  opt-in (a live key is refused at startup).
- Webhooks: HMAC-SHA256 signatures checked in constant time with a five-minute tolerance, then an inbox table so each
  event takes effect once, even when delivered ten times at once; the payment life cycle enforced by a trigger;
  money for a closed invoice or the wrong amount kept with a refund-due flag.
- Reconciliation that replays Stripe's event log for deliveries that never arrived.

### Roles, members and reminders (day 4)
- Roles (owner, admin, member) enforced on every page and Server Action, checked again inside the transaction.
- Members and single-use invitation links; the database keeps at least one owner per organization.
- A background worker that sends overdue reminders (1, 7, 14 and 30 days) exactly once per stage, safe to run as
  several replicas.
- A tenant-isolation suite that calls every route and Server Action as another organization's owner.

### Deployment (day 5)
- Container images from one Dockerfile: `web` (Next.js standalone server), `worker` (the worker bundled with esbuild)
  and `migrate` (the release step, production dependencies only); run as an unprivileged user, no secrets in any
  layer, base image pinned by digest. CI builds them, runs the release step, and runs the e2e suite against the web
  container.
- Members can leave an organization (not its last owner).
- `npm start` and the e2e suite run the standalone server, the same one the image runs.
