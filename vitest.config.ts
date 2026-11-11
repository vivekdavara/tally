import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests need Postgres with scripts/db-setup.sh run; they fail (not skip) when it's missing.
const appUrl = process.env.TEST_DATABASE_URL ?? "postgresql://tally_app@localhost:5432/tally_test";
const ownerUrl = process.env.TEST_MIGRATE_DATABASE_URL ?? "postgresql://tally_owner@localhost:5432/tally_test";
// A superuser (the role-check tests create throwaway roles in transactions that roll back). Locally the
// Homebrew cluster's superuser is this machine's user; CI sets postgres.
const adminUrl = process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://localhost:5432/tally_test";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      DATABASE_URL: appUrl,
      TEST_DATABASE_URL: appUrl,
      TEST_MIGRATE_DATABASE_URL: ownerUrl,
      TEST_ADMIN_DATABASE_URL: adminUrl,
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
