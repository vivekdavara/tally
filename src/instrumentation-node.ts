// If the database role could bypass row-level security, the server exits rather than run with tenant
// isolation silently off. Throwing isn't enough: Next.js logs a failed instrumentation hook and keeps the
// process up, answering every request with a 500, which a supervisor would count as a running server.
//
// It is also bounded in time: Next.js holds every request until this module finishes, so a check that
// hung would leave a process that neither serves nor exits. Connecting already gives up after 5 s
// (createDb); the timer covers anything else that could stall.
import { readBillingConfig } from "./server/billing/config";
import { db } from "./server/db/client";
import { assertSafeAppRole } from "./server/db/role-check";

const STARTUP_CHECK_MS = 15_000;

let timer: NodeJS.Timeout | undefined;
try {
  // Billing settings too (a live Stripe key, a missing signing secret): refused here, not at the first payment.
  readBillingConfig();
  await Promise.race([
    assertSafeAppRole(db()),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the database didn't answer within ${STARTUP_CHECK_MS / 1000} s`)), STARTUP_CHECK_MS);
    }),
  ]);
} catch (error) {
  console.error("tally: not starting:", error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
