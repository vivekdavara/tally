import type { Db } from "./client";
import { TENANT_TABLES } from "./tenant";

/** Every table the application uses. */
export const APP_TABLES = [
  "users",
  "organizations",
  "memberships",
  "customers",
  "invoices",
  "invoice_lines",
  "invoice_counters",
  "payments",
  "stripe_events",
  "invitations",
  "reminders",
] as const;

/** Tables under row-level security: the tenant tables, and memberships (writes only). */
export const RLS_TABLES = [...TENANT_TABLES, "memberships"] as const;

/** The policies' condition, as Postgres deparses it (pg_get_expr). */
export const TENANT_CONDITION =
  "(organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)";

interface Policy {
  table: string;
  name: string;
  /** pg_policy.polcmd: r SELECT, a INSERT, w UPDATE, d DELETE, * ALL. */
  command: string;
  using: string | null;
  check: string | null;
}

/** Exactly the policies the migrations create. Any other policy (a permissive one ORs in) is a problem. */
export const EXPECTED_POLICIES: Policy[] = [
  ...TENANT_TABLES.map((table) => ({ table, name: "tenant_isolation", command: "*", using: TENANT_CONDITION, check: TENANT_CONDITION })),
  { table: "memberships", name: "memberships_read", command: "r", using: "true", check: null },
  { table: "memberships", name: "memberships_insert", command: "a", using: null, check: TENANT_CONDITION },
  { table: "memberships", name: "memberships_update", command: "w", using: TENANT_CONDITION, check: TENANT_CONDITION },
  { table: "memberships", name: "memberships_delete", command: "d", using: TENANT_CONDITION, check: null },
];

/**
 * Privileges tally_app must not have (migrations/*_least_privilege): TRUNCATE ignores row-level security;
 * REFERENCES and TRIGGER let a role attach code or constraints; deleting users or organizations cascades
 * without row security; choosing an id or changing organization_id reopens the cross-tenant key checks.
 */
export const FORBIDDEN: { table: string; privilege: string; column?: string }[] = [
  ...APP_TABLES.flatMap((table) => [
    { table, privilege: "TRUNCATE" },
    { table, privilege: "REFERENCES" },
    { table, privilege: "TRIGGER" },
  ]),
  // memberships and invoice_counters have no id: their keys start with organization_id, covered below.
  // stripe_events' id is Stripe's event id, which the application must insert (and only a signed event reaches
  // that insert); it may never change one.
  ...APP_TABLES.filter((t) => t !== "memberships" && t !== "invoice_counters").flatMap((table) => [
    ...(table === "stripe_events" ? [] : [{ table, privilege: "INSERT", column: "id" }]),
    { table, privilege: "UPDATE", column: "id" },
  ]),
  { table: "memberships", privilege: "UPDATE", column: "user_id" },
  { table: "users", privilege: "DELETE" },
  { table: "organizations", privilege: "DELETE" },
  // "*": any column (has_any_column_privilege). Nothing may change a user (an email or password hash written
  // across organizations is an account takeover) or an organization (it has no row-level security).
  { table: "users", privilege: "UPDATE", column: "*" },
  { table: "organizations", privilege: "UPDATE", column: "*" },
  ...RLS_TABLES.map((table) => ({ table, privilege: "UPDATE", column: "organization_id" })),
  // Invoices (migrations/*_invoicing, *_bill_to_snapshot): the number, issue time, totals and bill-to details
  // are written only by the invoices_guard trigger at finalization; a number the application chose could skip
  // or repeat, a total it wrote could disagree with the lines, a bill-to it wrote could misaddress the invoice. The currency is fixed at creation (prices are in its minor unit).
  ...["number", "issued_at", "subtotal_minor", "tax_minor", "total_minor", "bill_to_name", "bill_to_email", "bill_to_address"].flatMap((column) => [
    { table: "invoices", privilege: "INSERT", column },
    { table: "invoices", privilege: "UPDATE", column },
  ]),
  { table: "invoices", privilege: "UPDATE", column: "currency" },
  // Deleting the counter would restart numbering at 1.
  { table: "invoice_counters", privilege: "DELETE" },
  // Moving a line between invoices (review of day 2; the trigger refuses it too).
  { table: "invoice_lines", privilege: "UPDATE", column: "invoice_id" },
  // Billing (migrations/*_billing): what a payment is for and where it is paid is written once, at creation;
  // only its outcome changes. Neither payments nor processed events are ever deleted.
  ...["invoice_id", "provider", "checkout_session_id", "checkout_url", "amount_minor", "currency", "expires_at"].map((column) => ({
    table: "payments",
    privilege: "UPDATE",
    column,
  })),
  { table: "payments", privilege: "DELETE" },
  ...["type", "payment_id", "stripe_created_at"].map((column) => ({ table: "stripe_events", privilege: "UPDATE", column })),
  { table: "stripe_events", privilege: "DELETE" },
  // Members (migrations/*_members): an invitation's address, role and token are written once; its times come from
  // the database's clock; it is never deleted. A membership's user never changes (its role does).
  ...["email", "role", "token_hash", "invited_by", "created_at", "expires_at", "accepted_at"].map((column) => ({
    table: "invitations",
    privilege: "UPDATE",
    column,
  })),
  ...["created_at", "expires_at", "accepted_at", "accepted_by", "revoked_at"].map((column) => ({ table: "invitations", privilege: "INSERT", column })),
  { table: "invitations", privilege: "DELETE" },
  // Reminders (migrations/*_reminders): which invoice, stage and recipient is written once (the recipient by the
  // trigger, from the invoice); only the sending bookkeeping changes; never deleted.
  ...["invoice_id", "stage", "recipient", "created_at"].map((column) => ({ table: "reminders", privilege: "UPDATE", column })),
  ...["recipient", "created_at", "attempts", "next_attempt_at", "last_error", "sent_at"].map((column) => ({ table: "reminders", privilege: "INSERT", column })),
  { table: "reminders", privilege: "DELETE" },
];

/**
 * The triggers that enforce the invoice life cycle and numbering (migrations/*_invoicing, *_review_d2) and the
 * payment life cycle (*_billing). Each must
 * exist and fire for ordinary sessions (tgenabled 'O', or 'A' for always); one disabled, dropped or set to fire
 * only for replicas would let any writer break the numbering or change a final invoice.
 */
export const EXPECTED_TRIGGERS: { table: string; name: string }[] = [
  { table: "invoices", name: "invoices_guard" },
  { table: "invoice_lines", name: "invoice_lines_guard" },
  { table: "invoice_counters", name: "invoice_counters_guard" },
  { table: "payments", name: "payments_guard" },
  { table: "stripe_events", name: "stripe_events_guard" },
  { table: "memberships", name: "memberships_guard" },
  { table: "invitations", name: "invitations_guard" },
  { table: "reminders", name: "reminders_guard" },
];

export interface RoleFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** The role the connection logged in as, when it isn't the current one (it set role at connect). */
  sessionUser: string | null;
  /**
   * Every other role this one is a member of. tally_app should be a member of none: SET ROLE to any of them
   * (a superuser, a BYPASSRLS role, pg_write_all_data, ...) would escape the checks below, which look only at
   * this role's own privileges because it is NOINHERIT.
   */
  memberOfRoles: string[];
  /** SECURITY DEFINER functions this role may execute: they run as their owner, who may bypass RLS. */
  definerFunctions: string[];
  /** Application tables whose owner this role is, or can become (SET ROLE). */
  ownedTables: string[];
  /** RLS tables where row-level security isn't both enabled and forced. */
  unprotectedTables: string[];
  /** Policies missing, changed or added, relative to EXPECTED_POLICIES. */
  policyProblems: string[];
  /** Entries of FORBIDDEN this role holds, as "PRIVILEGE on table" or "PRIVILEGE (column) on table". */
  forbiddenPrivileges: string[];
  /** app.organization_id as the connection found it ('' and null both mean unset). */
  presetTenant: string | null;
  /**
   * TEMP or CREATE on the database, CREATE on schema public: objects of its own (a temporary table shadows a
   * public one by name) are how a role would change what the triggers' queries see (review of day 2).
   */
  creationPrivileges: string[];
  /** EXPECTED_TRIGGERS that are missing or not firing for ordinary sessions. */
  missingTriggers: string[];
  /**
   * session_replication_role when it isn't 'origin'. Under 'replica' ordinary triggers don't fire, and that
   * includes the guards and the foreign keys' own triggers (review round 2 of day 2): a role default
   * (ALTER ROLE ... SET) is the usual way to get there.
   */
  replicationRole: string | null;
}

/**
 * Why a connection's role would switch row-level security off or around, if it would (DESIGN.md, "Layer
 * 3"). An empty list means safe.
 */
export function roleProblems(facts: RoleFacts): string[] {
  const problems: string[] = [];
  if (facts.superuser) problems.push(`${facts.role} is a superuser, which bypasses row-level security`);
  if (facts.bypassRls) problems.push(`${facts.role} has BYPASSRLS`);
  if (facts.sessionUser) {
    problems.push(`the connection logged in as ${facts.sessionUser}, not ${facts.role}, and can RESET ROLE`);
  }
  if (facts.memberOfRoles.length > 0) {
    problems.push(`${facts.role} can SET ROLE to ${facts.memberOfRoles.join(", ")}`);
  }
  if (facts.definerFunctions.length > 0) {
    problems.push(`${facts.role} may execute SECURITY DEFINER functions: ${facts.definerFunctions.join(", ")}`);
  }
  if (facts.ownedTables.length > 0) {
    problems.push(`${facts.role} owns or can become the owner of ${facts.ownedTables.join(", ")}`);
  }
  if (facts.unprotectedTables.length > 0) {
    problems.push(`row-level security is not enabled and forced on ${facts.unprotectedTables.join(", ")}`);
  }
  problems.push(...facts.policyProblems);
  if (facts.forbiddenPrivileges.length > 0) {
    problems.push(`${facts.role} holds privileges it must not: ${facts.forbiddenPrivileges.join("; ")}`);
  }
  if (facts.presetTenant) {
    problems.push(`connections start with app.organization_id already set (${facts.presetTenant})`);
  }
  if (facts.creationPrivileges.length > 0) {
    problems.push(`${facts.role} may create objects: ${facts.creationPrivileges.join(", ")}`);
  }
  if (facts.missingTriggers.length > 0) {
    problems.push(`guard triggers missing or disabled: ${facts.missingTriggers.join(", ")}`);
  }
  if (facts.replicationRole) {
    problems.push(`session_replication_role is ${facts.replicationRole}, so no trigger (guards, foreign keys) fires`);
  }
  return problems;
}

function comparePolicies(actual: Policy[]): string[] {
  const key = (p: Policy) => `${p.table}.${p.name}`;
  const expected = new Map(EXPECTED_POLICIES.map((p) => [key(p), p]));
  const problems: string[] = [];
  for (const p of actual) {
    const want = expected.get(key(p));
    if (!want) {
      problems.push(`unexpected policy ${p.name} on ${p.table}`);
    } else if (want.command !== p.command || want.using !== p.using || want.check !== p.check) {
      problems.push(`policy ${p.name} on ${p.table} differs from the migration's`);
    }
    expected.delete(key(p));
  }
  for (const p of expected.values()) problems.push(`policy ${p.name} on ${p.table} is missing`);
  return problems.sort();
}

/** Works on a client or inside a transaction. */
export async function readRoleFacts(client: Pick<Db, "$queryRaw">): Promise<RoleFacts> {
  const appTables = [...APP_TABLES];
  const rlsTables = [...RLS_TABLES];
  const forbiddenTables = FORBIDDEN.map((f) => f.table);
  const forbiddenPrivileges = FORBIDDEN.map((f) => f.privilege);
  const forbiddenColumns = FORBIDDEN.map((f) => f.column ?? "");
  const triggerTables = EXPECTED_TRIGGERS.map((t) => t.table);
  const triggerNames = EXPECTED_TRIGGERS.map((t) => t.name);
  const rows = await client.$queryRaw<
    {
      role: string;
      superuser: boolean;
      bypass_rls: boolean;
      session_user: string;
      member_of: string[];
      definers: string[];
      owned: string[];
      unprotected: string[];
      held: string[];
      preset: string | null;
      creation: string[];
      missing_triggers: string[];
      replication_role: string | null;
    }[]
  >`
    SELECT r.rolname::text AS role,
           r.rolsuper AS superuser,
           r.rolbypassrls AS bypass_rls,
           session_user::text AS session_user,
           ARRAY(SELECT o.rolname::text FROM pg_roles o
                 WHERE o.oid <> r.oid AND pg_has_role(r.oid, o.oid, 'MEMBER')
                 ORDER BY 1) AS member_of,
           ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace pn ON pn.oid = p.pronamespace
                 WHERE p.prosecdef AND pn.nspname NOT IN ('pg_catalog', 'information_schema')
                   AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
                 ORDER BY 1) AS definers,
           ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = ANY(${appTables}::text[])
                   AND pg_has_role(r.oid, c.relowner, 'MEMBER')
                 ORDER BY 1) AS owned,
           ARRAY(SELECT t FROM unnest(${rlsTables}::text[]) AS t
                 WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = 'public' AND c.relname = t
                                     AND c.relrowsecurity AND c.relforcerowsecurity)
                 ORDER BY 1) AS unprotected,
           ARRAY(SELECT CASE WHEN f.col = '' THEN f.priv || ' on ' || f.tbl
                             WHEN f.col = '*' THEN f.priv || ' (any column) on ' || f.tbl
                             ELSE f.priv || ' (' || f.col || ') on ' || f.tbl END
                 FROM unnest(${forbiddenTables}::text[], ${forbiddenPrivileges}::text[], ${forbiddenColumns}::text[])
                      AS f(tbl, priv, col)
                 WHERE to_regclass('public.' || f.tbl) IS NOT NULL
                   AND CASE WHEN f.col = '' THEN has_table_privilege(r.oid, ('public.' || f.tbl)::regclass, f.priv)
                            WHEN f.col = '*' THEN has_any_column_privilege(r.oid, ('public.' || f.tbl)::regclass, f.priv)
                            ELSE has_column_privilege(r.oid, ('public.' || f.tbl)::regclass, f.col, f.priv) END
                 ORDER BY 1) AS held,
           NULLIF(current_setting('app.organization_id', true), '') AS preset,
           ARRAY(SELECT v.p FROM (VALUES
                   ('TEMP on the database', has_database_privilege(r.oid, current_database(), 'TEMP')),
                   ('CREATE on the database', has_database_privilege(r.oid, current_database(), 'CREATE')),
                   ('CREATE on schema public', has_schema_privilege(r.oid, 'public', 'CREATE'))) AS v(p, held)
                 WHERE v.held ORDER BY 1) AS creation,
           ARRAY(SELECT e.tbl || '.' || e.name FROM unnest(${triggerTables}::text[], ${triggerNames}::text[]) AS e(tbl, name)
                 WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                                   JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = 'public' AND c.relname = e.tbl AND t.tgname = e.name
                                     AND t.tgenabled IN ('O', 'A'))
                 ORDER BY 1) AS missing_triggers,
           NULLIF(current_setting('session_replication_role'), 'origin') AS replication_role
    FROM pg_roles r
    WHERE r.rolname = current_user`;
  const row = rows[0];
  if (!row) {
    throw new Error("role check: current_user has no pg_roles row");
  }
  const policies = await client.$queryRaw<Policy[]>`
    SELECT c.relname::text AS "table", p.polname::text AS name, p.polcmd::text AS command,
           pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS "check"
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY 1, 2`;
  const restrictive = await client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND (NOT p.polpermissive OR p.polroles <> '{0}')`;
  const policyProblems = comparePolicies(policies);
  if ((restrictive[0]?.n ?? 0n) > 0n) {
    policyProblems.push("a policy is restrictive or limited to particular roles, unlike the migration's");
  }
  return {
    role: row.role,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    sessionUser: row.session_user === row.role ? null : row.session_user,
    memberOfRoles: row.member_of,
    definerFunctions: row.definers,
    ownedTables: row.owned,
    unprotectedTables: row.unprotected,
    policyProblems,
    forbiddenPrivileges: row.held,
    presetTenant: row.preset,
    creationPrivileges: row.creation,
    missingTriggers: row.missing_triggers,
    replicationRole: row.replication_role,
  };
}

/** Throws unless the connection's role is bound by row-level security exactly as the migrations intend. */
export async function assertSafeAppRole(client: Pick<Db, "$queryRaw">): Promise<void> {
  const problems = roleProblems(await readRoleFacts(client));
  if (problems.length > 0) {
    throw new Error(`refusing to serve: ${problems.join("; ")}`);
  }
}
