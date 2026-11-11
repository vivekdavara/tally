import type { Db } from "./client";
import { TENANT_TABLES } from "./tenant";

export interface RoleFacts {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Tenant tables whose owner this role is, or can become (SET ROLE). */
  ownedTenantTables: string[];
  /** Tenant tables where row-level security isn't both enabled and forced. */
  unprotectedTenantTables: string[];
}

/**
 * Why a connection's role would switch row-level security off, if it would (DESIGN.md, "Layer 3"). A
 * superuser or a BYPASSRLS role skips every policy; an owner can disable them. An empty list means safe.
 */
export function roleProblems(facts: RoleFacts): string[] {
  const problems: string[] = [];
  if (facts.superuser) problems.push(`${facts.role} is a superuser, which bypasses row-level security`);
  if (facts.bypassRls) problems.push(`${facts.role} has BYPASSRLS`);
  if (facts.ownedTenantTables.length > 0) {
    problems.push(`${facts.role} owns or can become the owner of ${facts.ownedTenantTables.join(", ")}`);
  }
  if (facts.unprotectedTenantTables.length > 0) {
    problems.push(`row-level security is not enabled and forced on ${facts.unprotectedTenantTables.join(", ")}`);
  }
  return problems;
}

/** Works on a client or inside a transaction. */
export async function readRoleFacts(client: Pick<Db, "$queryRaw">): Promise<RoleFacts> {
  const tables = [...TENANT_TABLES];
  const rows = await client.$queryRaw<
    { role: string; superuser: boolean; bypass_rls: boolean; owned: string[]; unprotected: string[] }[]
  >`
    SELECT r.rolname::text AS role,
           r.rolsuper AS superuser,
           r.rolbypassrls AS bypass_rls,
           ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND c.relname = ANY(${tables}::text[])
                   AND pg_has_role(current_user, c.relowner, 'MEMBER')
                 ORDER BY 1) AS owned,
           ARRAY(SELECT t FROM unnest(${tables}::text[]) AS t
                 WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                   WHERE n.nspname = 'public' AND c.relname = t
                                     AND c.relrowsecurity AND c.relforcerowsecurity)
                 ORDER BY 1) AS unprotected
    FROM pg_roles r
    WHERE r.rolname = current_user`;
  const row = rows[0];
  if (!row) {
    throw new Error("role check: current_user has no pg_roles row");
  }
  return {
    role: row.role,
    superuser: row.superuser,
    bypassRls: row.bypass_rls,
    ownedTenantTables: row.owned,
    unprotectedTenantTables: row.unprotected,
  };
}

/** Throws unless the connection's role is bound by row-level security on every tenant table. */
export async function assertSafeAppRole(client: Pick<Db, "$queryRaw">): Promise<void> {
  const problems = roleProblems(await readRoleFacts(client));
  if (problems.length > 0) {
    throw new Error(`refusing to serve: ${problems.join("; ")}`);
  }
}
