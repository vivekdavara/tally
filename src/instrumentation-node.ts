// If the database role could bypass row-level security, the server exits rather than run with tenant
// isolation silently off. Throwing isn't enough: Next.js logs a failed instrumentation hook and keeps the
// process up, answering every request with a 500, which a supervisor would count as a running server.
import { db } from "./server/db/client";
import { assertSafeAppRole } from "./server/db/role-check";

try {
  await assertSafeAppRole(db());
} catch (error) {
  console.error("tally: not starting:", error instanceof Error ? error.message : error);
  process.exit(1);
}
