# Walkthrough: questions about Tally, answered from the code

Day 1 covers the foundation: tenant isolation, the schema, roles, authentication. Later days add invoices, billing,
roles and the full isolation suite, and this file grows with them.

## The design

**What is Tally, in one sentence?**
A multi-tenant invoicing service where many businesses share one Postgres database, built so that one business can
never see another's data even if a query in the application forgets to filter.

**How do you keep tenants apart?**
Three layers (DESIGN.md, "Tenant isolation"):
1. `requireMembership(slug)` in `src/server/dal.ts` turns the URL's slug into the signed-in user's membership, or a
   404. Every tenant page and Server Action calls it.
2. `withTenant(orgId, fn)` in `src/server/db/tenant.ts` runs `fn` in one transaction after
   `set_config('app.organization_id', orgId, true)`. The org id comes from the membership, never from the URL.
3. Row-level security policies on `customers`, `invoices` and `invoice_lines` (`prisma/migrations/*_row_level_security`)
   compare each row's `organization_id` with that setting, for reads and writes.

**If the application already filters by organization, why also use row-level security?**
Because the failure I'm guarding against is a filter someone forgot. The application's filters are the normal
path; RLS is what still holds when one is missing, and it covers raw SQL too (`applies to raw SQL too` in
`tests/integration/rls.test.ts`).

**Why `FORCE ROW LEVEL SECURITY`, and why two database roles?**
Postgres exempts table owners from their tables' policies unless the table is forced, and always exempts superusers
and roles with `BYPASSRLS`. Migrations need an owner (`tally_owner`); the app connects as `tally_app`, which is none
of those (`scripts/db-setup.sh`). Forcing the tables also binds the owner, so even a script run as the owner can't
silently read across tenants.

**What stops someone deploying it with the wrong database user?**
`assertSafeAppRole` (`src/server/db/role-check.ts`) asks Postgres who the connection is: superuser, `BYPASSRLS`,
owner (or able to `SET ROLE` to the owner) of a tenant table, or a tenant table whose RLS isn't enabled and forced.
Any of those and the server exits at startup (`src/instrumentation-node.ts`), and `/api/health` answers 503.

**Why exit instead of throwing?**
I tried throwing first. Next.js logs a failed instrumentation hook and keeps the process running, answering every
request with a 500 (seen with `next start` as `tally_owner`). Nothing leaks, but a supervisor sees a live process,
not a crashed one. `process.exit(1)` makes the misconfiguration a crash, which is what it is. It lives in a separate
Node-only module because Next.js also compiles `instrumentation.ts` for the Edge runtime, which has no
`process.exit`.

**How do you stop a page from passing the wrong organization id to `withTenant`?**
Pages don't get one. `requireTenant(slug)` (`src/server/dal.ts`) does the membership check and returns a `run(fn)`
already bound to that organization, so the only id a page can use is the one the check found. Two tests over the
source keep it that way (`tests/unit/architecture.test.ts`): `withTenant` may only be called from the data access
layer, and every query on a tenant table must run on a transaction client named `tx`. The old version of the
organization page, which called `withTenant` itself, fails the first.

## The tenant setting

**Why `set_config(..., true)` instead of `SET app.organization_id = ...`?**
The `true` makes it local to the transaction. When the transaction ends, the setting is gone, so the pooled
connection goes back with no tenant. A session-level setting would stay on the connection and the next request to
get it would run as the previous tenant. There's a test that shows the leak with `set_config(..., false)` on a
one-connection pool (`would leak to the next transaction if the setting were session-level`).

**What happens when no tenant is set?**
No rows. `current_setting('app.organization_id', true)` returns `NULL` if it was never set in the session, and `''`
if a transaction set it and has ended (Postgres keeps the placeholder with an empty value). The policy wraps it in
`NULLIF(..., '')`, so both become `NULL`, and `organization_id = NULL` is never true. Inserts fail the `WITH CHECK`.
Tests cover both cases; the `''` one needs a one-connection pool so the second query is sure to reuse the
connection.

**Would this work behind PgBouncer?**
The design fits transaction pooling: everything that depends on the setting happens inside one transaction, which
is the unit PgBouncer hands out, while a session-level `SET` is exactly what breaks there. I haven't run it behind
PgBouncer, though; that would also need checking how Prisma's prepared statements behave with the pooler version.

**Can a tenant learn anything about another tenant's data?**
Not through the tenant tables: another tenant's rows can't be found, updated, deleted or written
(`tests/integration/rls.test.ts`). The subtle channel is key checks: Postgres checks foreign keys and unique keys
without row security, so any key that spans tenants answers "does this exist over there?". The composite foreign key
`(organization_id, customer_id)` makes another tenant's customer id fail exactly like a random one (a test compares
the errors). My first version still leaked through unique keys, which the review found: `(invoice_id, position)` and
the primary keys. Now unique keys on tenant tables start with `organization_id`, and the app role can't choose ids at
all (`tests/review/unique-oracle.test.ts`).

**What does isolation cost?**
Measured with `npm run bench` (README, "Results"): a one-round-trip count with no isolation took 426 µs at the
median; the same count through `withTenant` took 783 µs. The difference is the three extra round trips (`BEGIN`,
`set_config`, `COMMIT`); the query plans are the same index scan. In a real request, the transaction usually holds
several queries, so the overhead is paid once per request, not per query.

**How do you know the policy doesn't force a sequential scan?**
`tests/integration/rls-plan.test.ts` disables sequential scans and checks the plan is an index scan on an
`organization_id` index with the policy's expression as the index condition. I checked the test catches the
regression it's for: with the policy rewritten to call a `plpgsql` volatile function, Postgres plans a sequential
scan even with them disabled.

**Why can't the application delete an organization?**
Because the delete would cascade through that organization's customers and invoices, and cascades run without row
security. Before review round 1 fixed it, one `tx.organization.delete({ where: { id: otherOrg } })` inside my own
tenant's transaction emptied another tenant. Now `tally_app` has no `DELETE` on organizations or users, can't change
any id (and ids are `ON UPDATE NO ACTION`, so a change couldn't cascade either), and memberships, which every layer
trusts, can only be written for the transaction's own tenant. An administrator deletes organizations as the owner
role.

**What does the role check actually check?**
Everything that would turn row-level security off or around for the connection: superuser, `BYPASSRLS`, being able to
`SET ROLE` to either, owning an application table, RLS not enabled and forced, any policy different from the
migrations' (so an extra `USING (true)` policy is caught), any privilege the least-privilege migration removed, or a
tenant already set when the connection opens. Its tests create throwaway roles and grants inside a superuser
transaction that rolls back, `SET LOCAL ROLE tally_app`, and read the facts.

## Authentication

**How do sessions work? Can you revoke one?**
Auth.js v5 with the Credentials provider and JWT sessions (Auth.js requires JWTs with Credentials). The token holds
only the user id (`src/auth.ts` strips it to `sub` and its times). It can't be revoked before it expires (7 days),
but it grants nothing by itself: `requireUser` re-reads the user on every request (a deleted user is signed out),
and `requireMembership` re-reads the membership, so removing someone from an organization takes effect on their
next request.

**How are passwords stored?**
scrypt from Node's `crypto` (N = 2^15, r = 8, p = 1, a 16-byte random salt, a 32-byte key), stored as
`scrypt$N$r$p$salt$key` so the parameters can be raised later and old hashes still verify
(`src/server/auth/password.ts`). Passwords are NFKC-normalized first, so "café" typed with a composed or a
decomposed accent is the same password. Comparison is `timingSafeEqual`. One hash takes about 45 ms here.

**Why bound the parameters when parsing a stored hash?**
Verification reads N, r and p from the stored string. A corrupted or tampered value could ask for N = 2^30 and
take gigabytes and minutes for one sign-in. `parseHash` refuses anything outside a sane range, and a malformed hash
verifies nothing.

**Can an attacker tell which emails have accounts?**
Not from sign-in: a wrong password and an unknown email get the same message, and the unknown-email path still runs
one scrypt against a dummy hash so the timing matches (a test checks both paths take at least 20 ms; skipping the
dummy hash fails it). Sign-up does say "An account with this email already exists", as most sign-up forms do; hiding
that needs email verification.

**What happens when two people sign up at once?**
Sign-up is one transaction: user, organization, OWNER membership (`src/server/auth/signup.ts`). The database's unique
indexes decide races. Same email: exactly one succeeds and the rest get `email_taken`, and the losers leave no rows
(6 concurrent sign-ups in the test). Same organization name: the slug collides, the transaction rolls back and is
retried with a random 6-character suffix, so all succeed (8 concurrent sign-ups, 8 distinct slugs). Prisma 7's pg
adapter reports the violated constraint's name under `meta.driverAdapterError`, which is how the two cases are told
apart.

**What protects the pages in the browser?**
Security headers on every response (`next.config.ts`, checked by `e2e/headers.spec.ts`): no framing
(`frame-ancestors 'none'`, `X-Frame-Options: DENY`) so the sign-in form can't be clickjacked, `nosniff`, a referrer
policy so invoice URLs don't leak to other sites, a Permissions-Policy, and HSTS for HTTPS. There's no
`script-src` restriction yet, because Next.js's inline scripts would need a per-request nonce, which makes every
page dynamic; that's a trade-off I'd revisit before production.

**Why 404 and not 403 for an organization you don't belong to?**
A 403 would confirm the organization exists. `findMembership` returns one `null` for both cases, and the e2e test
checks the two responses are both 404.

## Testing

**How do you test isolation?**
Against real Postgres, as the application's own role: fixtures for two tenants, then every way of crossing over:
reading, finding by id, updating, deleting, inserting into the other tenant, moving a row to it, referencing its
customer, raw SQL, queries made on another client inside `withTenant`, 60 concurrent transactions over three
connections. Plus schema checks: every table with an `organization_id` (except `memberships`) has forced RLS and one
policy, and the app role can't touch `_prisma_migrations`.

**How do you know the tests test anything?**
Mutation checks: I broke each mechanism and watched a test fail (and the review listed the ones that survived, which
now have tests). A session-level `set_config` fails two tests;
dropping `set_config` fails the fixtures; skipping the dummy hash fails the timing test; treating a slug collision
as a taken email fails two tests; a plain `byte % 36` in the slug suffix fails the uniformity test (chi-square 557
against a limit of 90).

**What did you get wrong along the way?**
- The startup check first threw instead of exiting, which left a server answering 500s (above).
- Auth.js logged every failed sign-in as an error with a stack trace; my first fix compared `error.name`, which the
  production build minifies to a single letter. It uses `instanceof CredentialsSignin` now.
- A test compared two error messages after blanking ids in different ways; it failed in a checkout whose path held
  a UUID-shaped folder name. Running CI's steps in a fresh clone found it.
- Playwright starts `webServer` before `globalSetup`, so migrating in global setup was too late for the server's
  startup check; the server command runs the migrations first.

## What the reviews found

**What did the review find that you'd missed?**
Round 1 (an agent reviewing the day's work for correctness, writing each finding as a failing test) found nine bugs.
The ones worth telling:
- **Writes after a rollback, in Prisma itself.** If `fn` threw while a nested write was waiting on a row lock,
  Prisma 7.10 rolled back and released the connection, and the rest of the nested write then ran in autocommit:
  the organization rename was rolled back, the membership created in the same call was committed. `withTenant`
  now waits for every query `fn` started before letting the transaction end
  (`tests/review/rollback-then-write.test.ts`).
- **A silent rollback reported as success.** `fn` caught a unique violation and returned; Postgres answered `COMMIT`
  with `ROLLBACK`, and `withTenant` returned the id of a row that didn't exist. A `SELECT 1` before commit fixes it.
- **Cross-tenant writes through the tables RLS didn't cover**, and **the unique-key side channel** (above).
- **A role check that passed while isolation was broken** (an extra permissive policy, a `TRUNCATE` grant, a tenant
  preset in the connection URL).
- A startup check that could hang forever, hashes that parsed but couldn't be verified, a NUL byte making sign-up a
  500, and the redirect loop for a deleted user (which I had found and fixed an hour earlier).
It also listed 18 mutants no test caught; each now fails a test.

**And the second round?**
I asked a second review what the fixes broke, and it found five more: Prisma's own transaction timeout released the
connection mid-plan just like a rejection (now every statement has a lock and statement timeout far inside the
transaction timeout); my tracking view broke Prisma's fluent API (`findUnique(...).invoices()`); revoking deletes had
left `UPDATE (name, slug)` on organizations, so a tenant could take another's slug; the role check missed a superuser
session that had set its role, `UPDATE` on users, a `SECURITY DEFINER` function, and membership in
`pg_write_all_data` (invisible because the role is `NOINHERIT`); and RFC 7914's `N < 2^(16 r)` rule. As on earlier
projects, each round found bugs in the previous round's fixes.

## What I'd do next, or differently at scale

- Rate-limit sign-in (day 4), and email verification to stop sign-up from revealing accounts.
- Put RLS on `memberships` too, keyed by a transaction-local user id, so the membership lookup is also enforced by
  the database.
- At scale: the three extra round trips per request could be removed by sending `BEGIN; set_config; ...` as one
  pipelined batch; very large tenants might move to their own database, which the `organization_id` everywhere makes
  a data migration rather than a redesign.
