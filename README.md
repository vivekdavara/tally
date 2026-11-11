# Tally

A multi-tenant invoicing service. Businesses sign up as **organizations**, keep their **customers**, and (from day
2) send them **invoices**. Every organization's data lives in one shared Postgres database, so the property the
whole design is built around is **tenant isolation**: a request made for one organization can't read or change
another's data, even when the application code has a bug.

Next.js 16 (App Router, Server Components, Server Actions), Prisma 7 with the `pg` driver adapter, PostgreSQL 14
row-level security, Auth.js v5, Zod, Vitest, Playwright, TypeScript.

**Status: day 1 of 5.** Design, scaffold, schema and migrations with row-level security, database roles, sign-up and
sign-in, the first tenant page, tests and CI. [DESIGN.md](DESIGN.md) is the specification;
[WALKTHROUGH.md](WALKTHROUGH.md) answers the questions an interviewer is likely to ask.

## Why

Most multi-tenant bugs are a missing `WHERE organization_id = ...`: one forgotten filter in one query, and a
customer sees another company's invoices. Tally doesn't rely on every query remembering. Isolation is enforced in
three places, each enough to stop that bug on its own:

1. **Every tenant route resolves a membership first.** `/o/[slug]/...` pages call `requireMembership(slug)`, which
   answers 404 for a non-member exactly as for a slug that doesn't exist.
2. **Tenant data is only reached through `withTenant(orgId, fn)`**, which runs `fn` in one transaction after
   `set_config('app.organization_id', orgId, true)`. The setting is transaction-local, so a pooled connection never
   carries a tenant into the next request.
3. **Postgres row-level security**, enabled and *forced* on every tenant table, filters every query (Prisma's or raw
   SQL) to the tenant in that setting, and refuses writes into any other. The application connects as `tally_app`:
   not a superuser, no `BYPASSRLS`, owns nothing, so the policies bind it. The server checks this at startup and
   exits if they wouldn't.

On top of that, composite foreign keys (`(organization_id, customer_id)` → `customers (organization_id, id)`) make a
row that references another tenant's row impossible to store, and the application role's grants are column by column:
it can't choose or change ids, change `organization_id`, or delete organizations or users, because cascades and key
checks run without row security.

## Architecture

```mermaid
flowchart LR
    B[Browser] --> P["Page / Server Action<br/>(Next.js, Node runtime)"]
    P --> A["Auth.js<br/>JWT cookie: user id only"]
    P --> D["requireMembership(slug)<br/>404 unless a member"]
    D --> T["withTenant(orgId, fn)<br/>one transaction"]
    T -->|"set_config('app.organization_id', orgId, true)"| PG[("PostgreSQL 14<br/>RLS forced on customers,<br/>invoices, invoice_lines")]
    T -->|"as tally_app"| PG
    M["prisma migrate deploy"] -->|"as tally_owner"| PG
    S["startup + /api/health:<br/>assertSafeAppRole"] --> PG
```

## Layout

```
DESIGN.md                        the specification
prisma/schema.prisma             the data model
prisma/migrations/               SQL: tables and CHECKs; row-level security and grants
scripts/db-setup.sh              roles (tally_owner, tally_app) and databases, idempotent
scripts/bench-tenant.ts          what isolation costs per query
scripts/bench-signin.ts          whether sign-in timing reveals which emails exist
src/server/db/tenant.ts          withTenant
src/server/db/role-check.ts      assertSafeAppRole: is RLS binding this connection?
src/server/auth/                 passwords (scrypt), Zod schemas, credentials, sign-up
src/server/dal.ts                requireUser, requireMembership
src/auth.ts                      Auth.js configuration
src/app/                         pages, Server Actions, /api/auth, /api/health
tests/unit, tests/integration    Vitest (integration tests against real Postgres)
e2e/                             Playwright
```

## Running it

Requirements: Node 22.12+ or 24 (Prisma 7's range), PostgreSQL 14 on localhost:5432 with trust authentication for
local connections (Homebrew's default), and Google Chrome for the e2e tests.

```bash
npm install
scripts/db-setup.sh                 # roles tally_owner + tally_app; databases tally, tally_test, tally_e2e
cp .env.example .env                # then set AUTH_SECRET: openssl rand -base64 32
npm run db:migrate                  # as tally_owner
npm run dev                         # http://localhost:8117
```

For production mode locally, `npm run build && AUTH_TRUST_HOST=true npm start` (Auth.js wants the trusted host stated
outside development). The server checks at startup that its database role is bound by row-level security and exits
if it isn't, so a `DATABASE_URL` pointing at `tally_owner` or a superuser won't start.

Checks:

```bash
npm run check                       # typecheck, lint, unit + integration tests (needs Postgres)
npm run build && npm run e2e        # Playwright against next start on :8117, database tally_e2e
scripts/db-setup.sh tally_bench && npm run bench && npm run bench:signin
```

On Node 23 (this Mac's), Prisma's preinstall refuses to run; `npm ci --ignore-scripts && npx prisma generate` works,
and everything else runs.

## Results (day 1)

All measured on an Apple M3 laptop (macOS 26.6.2, Node 23.11, Postgres 14.20), on AC power.

- **Tests:** 209 Vitest tests (`npx vitest run`, 22 s with files run one at a time): unit, integration tests
  against Postgres (mostly as `tally_app`), two architecture rules over the source, and the review rounds' tests
  (`tests/review/`, `tests/review2/`); 11 Playwright tests (`npm run e2e`, 6.5 s). Every CI step passed in a fresh clone
  of the repository.
- **The cost of isolation** (`npm run bench`, synthetic: 100 tenants x 1,000 customers; one tenant's customer count,
  3,000 times per path, interleaved; one connection each; load average 3.4; final code):

  | Path | p50 | p95 | p99 |
  |---|---|---|---|
  | superuser, explicit `WHERE`, no RLS (one round trip) | 409 µs | 527 µs | 654 µs |
  | `withTenant` (RLS adds the filter) | 914 µs | 1,314 µs | 1,927 µs |
  | `withTenant` plus an explicit `WHERE` | 919 µs | 1,345 µs | 2,253 µs |

  The cost is the four extra round trips (`BEGIN`, one `set_config` statement for the tenant and the timeouts, the
  `SELECT 1` that catches an aborted transaction, `COMMIT`), paid once per request rather than per query; not the
  policy: Postgres plans the RLS query and the explicit one the same way, a bitmap index scan on
  `customers_organization_id_id_key` (`tests/integration/rls-plan.test.ts` pins that the policy can use an index).
  Earlier runs, before the reviews' fixes: 426 / 783 / 794 µs at the median (load 3.9, no `SELECT 1`), then 393 /
  851 / 858 µs (load 3.0).
- **Password hashing:** one scrypt (N = 2^15, r = 8, p = 1) takes 45.5 ms at the median (20 runs, min 45.4, max
  46.7: a `node -e` timing loop over `crypto.scrypt`).
- **Sign-in timing doesn't reveal accounts** (`npm run bench:signin`: the whole credential check, 200 attempts of
  each kind, interleaved, load 2.8):

  | Attempt | p10 | p50 | p90 |
  |---|---|---|---|
  | wrong password for a real account | 49.2 ms | 49.6 ms | 52.0 ms |
  | email with no account | 49.2 ms | 49.6 ms | 52.1 ms |
  | right password | 49.3 ms | 49.6 ms | 51.8 ms |

  With the dummy hash removed (a mutation, 60 rounds), an unknown email answered in 0.8 ms at the median against
  49.7 ms for a wrong password: a timing oracle for which emails are registered.

## Review

Two review rounds by a separate agent, each reviewing a fixed commit in its own worktree and database, writing every
finding as a failing test (`tests/review/`).

- **Round 1** (at `135c11c`): nine bugs. The serious ones: writes from another tenant's transaction through the
  tables RLS didn't cover (deleting an organization cascaded through its rows; a membership in another organization
  was accepted); unique and primary keys that answered "does this exist in another tenant?"; a Prisma 7.10 behaviour
  where a rejected transaction's in-flight nested write finished in autocommit after the `ROLLBACK`; a swallowed
  error reported as success; a role check that passed with an extra `USING (true)` policy. Also a startup check
  that could hang, unverifiable hash parameters, a NUL byte making sign-up a 500, and the deleted-user redirect loop
  (already fixed). Plus 18 surviving mutants, each now killed by a test. Fixes: `e98f346` and the commits before it.
- **Round 2** (at `e98f346`, on round 1's fixes): five bugs. A transaction that hit Prisma's own timeout still
  committed part of a nested write (statements are now bounded by `lock_timeout` and `statement_timeout` well inside
  a 30 s transaction timeout); the tracking view broke Prisma's fluent API; another organization's name and slug
  were still writable (the app may no longer update organizations); the role check passed a superuser session that
  set its role, `UPDATE` on users, an executable `SECURITY DEFINER` function and membership in `pg_write_all_data`;
  `parseHash` accepted hashes no scrypt can run. Plus 12 surviving mutants: 11 now fail tests; the wait for
  in-flight queries before `COMMIT` still survives its test (the `SELECT 1` orders `COMMIT` after the plan in every
  case I could build) and stays as a guard. Fixes: `41d7c03`, `1eaaacf`.

## Design decisions

- **RLS as well as application filters, not instead of them.** The application still resolves memberships and
  scopes by organization; RLS is what still holds when one of those is forgotten.
- **A transaction per tenant request.** `set_config(..., true)` only lives inside a transaction, which is what makes
  it safe with a connection pool (and with PgBouncer in transaction mode). The price is three round trips per
  request, measured above.
- **A Prisma behaviour to report upstream.** When an interactive transaction ends (rejection or Prisma's timeout)
  while an operation's multi-query plan is running, the rest of the plan runs in autocommit on the released
  connection. `withTenant` works around it; the reproductions are in `tests/review2/orphan-writes.test.ts`.
- **Least privilege, column by column.** Some writes skip row security even for the app role (cascades, unique-key
  checks), so its grants leave out everything those could abuse; the startup check verifies the grants and policies
  are exactly the migrations'.
- **The app role can't be the owner.** Table owners skip RLS unless it's forced, superusers and `BYPASSRLS` roles
  always skip it. So there are two roles, the policies are forced, and the server refuses to start as anything RLS
  doesn't bind.
- **Composite foreign keys.** They make cross-tenant references unrepresentable and close a side channel: Postgres
  checks foreign keys without row security, so a plain `customer_id` key would tell a tenant whether another
  tenant's id exists.
- **Sessions carry identity, not authority.** The JWT holds only the user id; memberships and roles are read on
  every request, so removing someone takes effect immediately even though JWTs can't be revoked.
- **scrypt from Node's standard library**, parameters stored per hash, NFKC-normalized input, a dummy hash for
  unknown emails so sign-in timing doesn't reveal accounts.

## Limitations (day 1)

- Only sign-up, sign-in and an organization overview exist; customers and invoices arrive on day 2, billing on day
  3, roles enforced and the full isolation suite on day 4.
- Sign-up tells you when an email already has an account (as most sign-up forms do); hiding that needs an email
  verification flow, which needs an email provider.
- No rate limiting on sign-in yet (day 4).
- `users` and `organizations` have no row-level security, and memberships none for reading: they're read before a
  tenant is known. Writes to them are limited by grants instead (no deletes, no id changes; memberships only for the
  transaction's tenant).
- Auth.js v5 is still published as a beta (`5.0.0-beta.32`).
- `npm audit`: no advisories in the production dependencies; 8 moderate ones in the lint toolchain, all the same
  minimatch advisory (GHSA-g3hv-75wg-m249) reached through typescript-eslint, whose `^10.2.2` range can't reach the
  fixed 11.0.1. It only ever sees the repository's own lint globs.

MIT licensed.
