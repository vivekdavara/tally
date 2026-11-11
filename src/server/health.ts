import type { Db } from "./db/client";
import { assertSafeAppRole } from "./db/role-check";

export interface Health {
  status: "ok" | "unavailable";
}

/**
 * Ready only if the database answers and the connection's role is bound by row-level security. The reason
 * for a failure goes to the server log, not the response: it names roles and tables.
 */
export async function checkHealth(client: Db): Promise<{ httpStatus: number; body: Health }> {
  try {
    await assertSafeAppRole(client);
    return { httpStatus: 200, body: { status: "ok" } };
  } catch (error) {
    console.error("health check failed:", error instanceof Error ? error.message : error);
    return { httpStatus: 503, body: { status: "unavailable" } };
  }
}
