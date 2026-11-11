import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests need Postgres with scripts/db-setup.sh run; they fail (not skip) when it's missing.
const appUrl = process.env.TEST_DATABASE_URL ?? "postgresql://tally_app@localhost:5432/tally_test";
const ownerUrl = process.env.TEST_MIGRATE_DATABASE_URL ?? "postgresql://tally_owner@localhost:5432/tally_test";

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
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
