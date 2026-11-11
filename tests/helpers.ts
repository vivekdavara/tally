import { randomBytes } from "node:crypto";
import { createDb, type Db } from "@/server/db/client";

export function appUrl(): string {
  return process.env.TEST_DATABASE_URL!;
}

export function ownerUrl(): string {
  return process.env.TEST_MIGRATE_DATABASE_URL!;
}

/** A client connected as tally_app, the role the application uses. */
export function appDb(options: { max?: number } = {}): Db {
  return createDb(appUrl(), options);
}

/** A client connected as tally_owner, the role migrations use. */
export function ownerDb(options: { max?: number } = {}): Db {
  return createDb(ownerUrl(), options);
}

/** A superuser connection (local: this machine's user; CI: postgres), for tests that need one. */
export function adminDb(options: { max?: number } = {}): Db {
  return createDb(process.env.TEST_ADMIN_DATABASE_URL!, options);
}

/** A fresh suffix, so tests in parallel files never collide on unique columns. */
export function unique(): string {
  return randomBytes(6).toString("hex");
}
