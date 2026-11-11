import type { Db } from "./client";
import { TENANT_TABLES } from "./tenant";

/** Every table the application uses. */
export const APP_TABLES = ["users", "organizations", "memberships", "customers", "invoices", "invoice_lines"] as const;

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
  // memberships has no id: its key is (organization_id, user_id), covered by the organization_id rule.
  ...APP_TABLES.filter((t) => t !== "memberships").flatMap((table) => [
    { table, privilege: "INSERT", column: "id" },
    { table, privilege: "UPDATE", column: "id" },
  ]),
  { table: "memberships", privilege: "UPDATE", column: "user_id" },
  { table: "users", privilege: "DELETE" },
  { table: "organizations", privilege: "DELETE" },
  ...RLS_TABLES.map((table) => ({ table, privilege: "UPDATE", column: "organization_id" })),
];

export interface RoleFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Other roles this one is a member of (so can SET ROLE to) that are superusers or have BYPASSRLS. */
  privilegedRoles: string[];
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
}

/**
 * Why a connection's role would switch row-level security off or around, if it would (DESIGN.md, "Layer
 * 3"). An empty list means safe.
 */
export function roleProblems(facts: RoleFacts): string[] {
  const problems: string[] = [];
  if (facts.superuser) problems.push(`${facts.role} is a superuser, which bypasses row-level security`);
  if (facts.bypassRls) problems.push(`${facts.role} has BYPASSRLS`);
  if (facts.privilegedRoles.length > 0) {
    problems.push(`${facts.role} can SET ROLE to ${facts.privilegedRoles.join(", ")}, which bypass row-level security`);
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
  const rows = await client.$queryRaw<
    {
      role: string;
      superuser: boolean;
      bypass_rls: boolean;
      privileged: string[];
      owned: string[];
      unprotected: string[];
      held: string[];
      preset: string | null;
    }[]
  >`
    SELECT r.rolname::text AS role,
           r.rolsuper AS superuser,
           r.rolbypassrls AS bypass_rls,
           ARRAY(SELECT o.rolname::text FROM pg_roles o
                 WHERE o.oid <> r.oid AND (o.rolsuper OR o.rolbypassrls)
                   AND pg_has_role(r.oid, o.oid, 'MEMBER')
                 ORDER BY 1) AS privileged,
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
                             ELSE f.priv || ' (' || f.col || ') on ' || f.tbl END
                 FROM unnest(${forbiddenTables}::text[], ${forbiddenPrivileges}::text[], ${forbiddenColumns}::text[])
                      AS f(tbl, priv, col)
                 WHERE to_regclass('public.' || f.tbl) IS NOT NULL
                   AND CASE WHEN f.col = '' THEN has_table_privilege(r.oid, ('public.' || f.tbl)::regclass, f.priv)
                            ELSE has_column_privilege(r.oid, ('public.' || f.tbl)::regclass, f.col, f.priv) END
                 ORDER BY 1) AS held,
           NULLIF(current_setting('app.organization_id', true), '') AS preset
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
    privilegedRoles: row.privileged,
    ownedTables: row.owned,
    unprotectedTables: row.unprotected,
    policyProblems,
    forbiddenPrivileges: row.held,
    presetTenant: row.preset,
  };
}

/** Throws unless the connection's role is bound by row-level security exactly as the migrations intend. */
export async function assertSafeAppRole(client: Pick<Db, "$queryRaw">): Promise<void> {
  const problems = roleProblems(await readRoleFacts(client));
  if (problems.length > 0) {
    throw new Error(`refusing to serve: ${problems.join("; ")}`);
  }
}
