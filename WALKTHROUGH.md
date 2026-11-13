# Walkthrough: questions about Tally, answered from the code

Day 1 covers the foundation: tenant isolation, the schema, roles, authentication. Day 2 adds invoices: exact money,
gapless numbering, the life cycle in the database, PDFs. Later days add billing, roles and the full isolation suite,
and this file grows with them.

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

## Invoices (day 2)

**How do you represent money?**
As `bigint` counts of the currency's minor unit: $12.34 is `1234n`, ¥1,200 is `1200n`, 1.234 KWD is `1234n`
(`src/server/invoices/money.ts`, `CURRENCIES` holds each currency's ISO 4217 digits). Quantities and tax rates are
`bigint` thousandths (`numeric(12,3)` and `numeric(6,3)` in Postgres). No JavaScript `number` is ever involved, so
nothing is rounded by floating point; even display goes through `Intl.NumberFormat` with a decimal *string*, which it
formats exactly (`prints every digit of amounts far beyond a double's 2^53` in `tests/unit/money.test.ts`).

**What's your rounding rule, and why that one?**
Each line rounds half up to the minor unit; tax is computed once per tax rate on the sum of that rate's lines, rounded
half up; the total is the sum, with no further rounding (`computeTotals`). Per rate rather than per line keeps the tax
within half a cent of exact for each rate however many lines share it: three $0.10 lines at 5% owe 1.5 cents; per line
you'd charge 3 cents, per rate 2 (`taxes once per rate` in the money tests). And input is never rounded at all:
"12.345" dollars is refused, because silently storing 12.35 would charge something nobody typed.

**Why are the totals computed twice, in SQL and in TypeScript?**
The stored totals (what an open invoice is worth, what billing will charge) are written by the database's
finalization trigger, so the application can't write a wrong one: it has no privilege on those columns. The pages and
PDFs need per-line amounts and tax rows, which money.ts computes. Two implementations of one rule can drift, so
`tests/integration/totals-differential.test.ts` runs both on 600 random invoices (exact halves, the limits, mixed
rates) and requires identical answers; and `getInvoice` throws rather than show an invoice whose stored and computed
totals differ.

**How do you get invoice numbers with no gaps?**
A counter row per organization, `invoice_counters`, incremented by an upsert inside the finalizing transaction
(`invoices_guard` in `prisma/migrations/*_invoicing`). The upsert locks the row until commit, so concurrent
finalizations in one organization take turns, and a rollback undoes the increment, so the next finalization reuses the
number. `leaves no gaps and no repeats with 40 concurrent finalizations, a quarter of them rolled back` in
`tests/integration/invoices.test.ts` checks exactly 1..30 come out.

**Why not a Postgres sequence?**
Sequences are deliberately non-transactional: `nextval` never rolls back, so every failed or aborted finalization
would burn a number and leave a gap. That's fine for ids, wrong for invoice numbers, which tax rules in many countries
expect to run in sequence without gaps.

**What does the lock cost?**
Measured (`npm run bench:finalize` on the final code, README "Results (day 2)"): with 16 concurrent finalizations in
one organization, p95 23.5 ms and 1,669/s, against 8.3 ms and 2,655/s when the same 16 workers finalize in 16
different organizations (three runs, the same shape each time).
The lock only serializes one organization against itself, and only from the upsert to `COMMIT`.

**Why is the issue time taken after the number?**
So issue times can't run backwards against numbers. The counter lock means #N's transaction has committed before #N+1
gets its number; a timestamp taken after the number is therefore later than #N's. My first version took the time
before the upsert, and the 40-finalization test caught #N+1 stamped a millisecond earlier than #N.

**Why enforce the life cycle in triggers instead of in the service?**
The service checks first, for clear messages, but tenant isolation already taught that "every caller remembers" is
the weak point. The triggers hold for any writer (a bug, a script, raw SQL): a new invoice is a draft; only drafts
can be deleted; once final, nothing but the status changes, only OPEN → PAID or VOID; lines change only on drafts.
`a final invoice > refuses to ...` in the invoice tests issues each forbidden write as raw SQL and shows the trigger's
refusal.

**What stops a line being added while the invoice is being finalized?**
A lock. The lines trigger takes `FOR NO KEY UPDATE` on the line's invoice, which conflicts with the finalizing
`UPDATE`'s row lock. Either the line commits first and the finalization's totals include it, or the finalization
commits first and the line insert, once it gets the lock, sees an OPEN invoice and is refused. `a line write racing a
finalization` holds a finalization open, shows the insert waiting in `pg_stat_activity`, then commits and checks the
insert was refused and the totals didn't change. It's `NO KEY` so it doesn't conflict with the foreign-key check's
`FOR KEY SHARE`.

**Doesn't the counter table open a new cross-tenant channel?**
Its key is `organization_id` alone, and the row-level security policy's `WITH CHECK` only lets a transaction insert
its own organization's row, so the upsert's unique check can only ever collide with the tenant's own counter. The
application has no `DELETE` on it (that would restart numbering) and can't change its `organization_id`; the role
check refuses both.

**Why write your own PDF generator?**
An invoice is text, lines and page breaks, which PDF's built-in Helvetica covers without embedding a font, so the
writer is under 300 lines with no dependency (`src/server/invoices/pdf.ts`), its output deterministic, and the tests
check the file byte for byte (every xref offset points at its object; every stream length is exact). The trade-off is
the encoding: standard fonts use Windows-1252, so Latin text, € and dashes work and other scripts print "?". Supporting
them means embedding a TrueType subset, which is when a library like pdf-lib earns its place.

**How do you know the PDF looks right?**
`scripts/sample-pdf.ts` writes sample invoices; I rendered them to PNG with pypdfium2 and looked, and extracted the
text with pdfplumber, whose metrics showed every right-aligned line ending within 0.05 pt of the margin, after I
added Helvetica-Bold's widths (the bold "Amount" header overran by a few points when measured with regular widths).

**What did day 2's review find, and what does it say about the design?**
That the database enforcement had holes exactly where the application role still holds a grant. The counter needs
`INSERT`/`UPDATE` because the trigger runs as the caller, so any statement could move it (`+41` gave invoice 43); it now
has its own guard that accepts writes only from inside another trigger (`pg_trigger_depth() > 1`), one step at a time.
Two more were latent behind grants the app doesn't have (a temp table shadowing the triggers' tables; moving a line
out of a final invoice), fixed anyway and added to the startup role check, so a database set up differently fails
loudly. And the PDF writer drew text off the page for inputs the validation allows (`tests/review-d2/`).

**And round 2, on round 1's fixes?**
Seven bugs, five in or beside round 1's fixes, as on earlier projects: sizing PDF columns to the widest amount could
squeeze a description into more lines than a page; measuring every non-ASCII character as a digit; INR's ₹ printing
"?"; a decomposed accent cut from its letter; the role check missing `session_replication_role = replica` (no trigger
fires at all) and calling an `ENABLE ALWAYS` trigger missing; and an organization delete that worked only because of
the order Postgres fires cascades in. Each is a test in `tests/review-d2r2/`. Round 3 found three more, two in round
2's fixes (a grapheme cluster wider than the line; an address rule that counted line breaks, not printed lines), and
round 4 two in round 3's (names that wrap to more lines than their character count suggests, because words waste line
space).
The lesson I take: a fix is new code and needs its own review.

**Why not make the counter function `SECURITY DEFINER`, so the app needs no grant on the counter at all?**
A definer function runs with its owner's privileges: on these tables that's everything, far beyond the column grants
the application is held to, so any bug in such a function (or in how it resolves names) is a hole the grants no longer
cover. (Row-level security still applies, since the tables force it even for their owner.) D1's role check refuses to
start if the app can execute any definer function, a deliberately blunt rule, and the trigger-depth guard lets me
keep it.

**Why copy the customer's details onto a finalized invoice?**
An issued invoice is a document that was sent; if renaming a customer changed it, the PDF you'd regenerate for an
auditor wouldn't be the one the customer received. The trigger copies name, email and address at finalization and
freezes them with the rest (`a final invoice's bill-to details` in the invoice tests). Drafts still follow the
customer.

**What did your own tests catch on day 2?**
Three bugs: the issue time taken before the number (a concurrency test saw #N+1 stamped 1 ms before #N); a duplicate
customer email returning a 500, because the service caught the unique violation inside a transaction Postgres had
already aborted, which `withTenant`'s day-1 guard turns into an error at commit (the guard working as designed,
on code I'd just written); and bold text measured with regular widths. Plus a migration that Prisma applied only
halfway when an old row broke a new CHECK.

## Billing (day 3)

**How does an invoice get paid?**
Staff click "Create payment link" on an open invoice. `startCheckout` (`src/server/billing/service.ts`) creates a
hosted checkout session at the provider for the invoice's *stored* total and saves it as a `payments` row; the
customer pays on the provider's page; the provider sends a signed `checkout.session.completed` to
`/api/stripe/webhook`; `processCheckoutEvent` marks the payment SUCCEEDED and the invoice PAID in one transaction.
Tally never sees card details. In development and CI the provider is `MockProvider`, whose `/mock-checkout/<id>` page
plays the customer and sends the same signed events (`e2e/billing.spec.ts` does the whole flow in Chrome).

**Why not call Stripe inside the database transaction?**
A slow or hung HTTP call would hold the invoice's row lock and a pooled connection for its whole duration, and if the
transaction then rolled back, the session would exist at Stripe with no record here. So it's two transactions with the
call in between, and the idempotency key covers the gap: a crash after the call and before the insert is retried with
the same key and gets the same session back (`recovers the same session after a crash between the provider call and
the insert` in `tests/integration/billing.test.ts`).

**What's in the idempotency key, and why the digest?**
`tally-checkout-<invoice>-<attempt>-<16 hex of sha256(request)>` (`checkoutIdempotencyKey`). Invoice and attempt
make concurrent clicks and crash retries share one session; the attempt number moves on once an attempt has ended
(failed or expired), so a new link is a new session. The digest was review round 1's suspicion: Stripe refuses a key
reused with different parameters, permanently, so a retry after the organization was renamed would have been stuck
for 24 hours; with the digest, a different request is simply a different key.

**How do you verify a webhook?**
`verifySignature` (`signature.ts`): HMAC-SHA256 of `t + "." + raw body` with the endpoint secret, compared in constant
time with every `v1` in the header (more than one while a secret is being rolled), the signature checked before the
timestamp, and the timestamp within 5 minutes either way. The raw *bytes* matter: re-serialized JSON wouldn't match
(`refuses a body that differs only in whitespace or key order`). The scheme is checked against `openssl dgst -hmac`,
so a mistake shared by my signer and my verifier can't hide.

**How do you process each event exactly once?**
The first statement of the event's transaction inserts its id into `stripe_events` with `ON CONFLICT (id) DO NOTHING
RETURNING id`. Nothing returned means it was processed before: answer "duplicate", change nothing. If two deliveries
arrive together, the second insert waits on the first's uncommitted key and then sees the conflict; if the first
rolls back, the second goes ahead. The test sends one event 10 times at once and gets one "processed" and nine
"duplicate" (`takes effect once however often it's delivered`); the benchmark repeats it for thousands of events.

**Events can arrive out of order. What happens?**
Payment statuses only move forward, in the trigger (`payments_guard`) and in the service: PENDING to PROCESSING to
SUCCEEDED or FAILED, PENDING to EXPIRED, and SUCCEEDED is final. A settlement processed before the older "completed
(unpaid)" leaves the payment SUCCEEDED and calls the older one "stale" (`can't be undone by events arriving out of
order`). The one backwards-looking move allowed is FAILED or EXPIRED to SUCCEEDED: if money arrived, it's recorded.

**What if money arrives for an invoice that doesn't want it?**
It's recorded on the payment with `refund_due` set, and the invoice isn't touched: paid by hand already
(`refund-due-paid`), voided (`refund-due-void`), or the amount or currency differs from the payment's
(`amount-mismatch`). Refunding is a person's decision (and Stripe call) I haven't built; the flag and the "Refund due"
badge make it visible.

**How does the webhook know which tenant it's for, without a login?**
From the session's metadata, which Tally wrote when it created the session and Stripe signed with the rest of the
event. `runForStripeEvent` in `src/server/dal.ts` only accepts a `VerifiedCheckoutEvent`, a branded type that only the
parser returns after the signature verified, so an unverified organization id can't reach `withTenant` by accident.
Row security still applies inside: the payment is looked up by session id in that organization only, so an event that
names the wrong organization finds nothing (`can't touch another organization's payment by naming it in the
metadata`).

**What did the reviews find today?**
Round 1: an upper-case invoice id in the URL went into the session metadata as typed; the parser only accepted lower
case, so a paid checkout's events were acknowledged as "not ours" and the money never recorded. And a unique violation
from a raw query arrives as Prisma's P2010, not P2002, so the "checkout-busy" answer was dead code and a 500. Fixing
the second exposed two races my own 8-click test then caught: an identical session hitting the partial unique index
instead of the `ON CONFLICT` target, and the live check and the attempt count disagreeing under READ COMMITTED. Both
are closed by taking the invoice lock first. Its suspicions led to four more fixes (emoji-safe descriptions, Stripe's
409 for in-flight keys, the digest in the key, expiring a newer link when a late success pays the invoice).

**What did you find yourself?**
That Prisma 7.10's pg adapter drops time zones both ways, so on a non-UTC database every stored time was five hours
off; CI runs in UTC and would never have shown it. Every connection now runs in UTC and the test database runs in New
York time (`tests/integration/timezone.test.ts`). And a deadlock between two events for one payment: the inbox
insert's foreign-key check holds `FOR KEY SHARE` on the payment, which my `FOR UPDATE` conflicted with.

## What I'd do next, or differently at scale

- Rate-limit sign-in (day 4), and email verification to stop sign-up from revealing accounts.
- Refunds and partial payments: new payment and invoice states (PAID can't change today), a refund action for
  `refund_due` payments, and a reconciliation job that lists Stripe's events since the last one seen, for anything a
  webhook outage longer than Stripe's three days of retries would lose.
- Process webhooks from a queue: answer 200 as soon as the event is stored, apply it in a worker, as Stripe
  recommends at volume. Today the transaction is short enough (measured in the README) to do inline.
- Credit notes rather than editing a final invoice: a negative document that references the original, numbered in
  the same sequence; and an embedded font for PDFs in non-Latin scripts.
- If one organization ever finalized hundreds of invoices a second, number them in a batch (one counter update for
  many invoices) rather than giving up gaplessness.
- Put RLS on `memberships` too, keyed by a transaction-local user id, so the membership lookup is also enforced by
  the database.
- At scale: the three extra round trips per request could be removed by sending `BEGIN; set_config; ...` as one
  pipelined batch; very large tenants might move to their own database, which the `organization_id` everywhere makes
  a data migration rather than a redesign.
