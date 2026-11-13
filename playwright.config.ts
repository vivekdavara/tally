// End-to-end tests (`npm run e2e`): a real browser against `next start` on the project's port (8117) and its
// own database, tally_e2e (scripts/db-setup.sh creates it). Run `npm run build` first. It drives the Chrome installed on the machine (`channel: "chrome"`), so no browser is downloaded;
// GitHub's Ubuntu runners have Chrome too.
import { randomBytes } from "node:crypto";
import { defineConfig } from "@playwright/test";

// Made once in the runner; its workers load this file again and inherit the variables.
process.env.E2E_DATABASE_URL ??= "postgresql://tally_app@localhost:5432/tally_e2e";
process.env.E2E_MIGRATE_DATABASE_URL ??= "postgresql://tally_owner@localhost:5432/tally_e2e";
process.env.E2E_AUTH_SECRET ??= randomBytes(32).toString("base64");
// The webhook signing secret the server verifies with (billing runs on the mock provider): known to the tests so
// they can sign events and post them to /api/stripe/webhook over HTTP.
process.env.E2E_STRIPE_WEBHOOK_SECRET ??= `whsec_e2e_${randomBytes(24).toString("hex")}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI === undefined ? "list" : [["list"], ["github"]],
  use: { channel: "chrome", baseURL: "http://localhost:8117", trace: "retain-on-failure" },
  webServer: {
    // Migrations first, in the same command: Playwright starts webServer before any globalSetup, and the
    // server's startup check refuses a database without the row-level security policies.
    command: "node_modules/.bin/prisma migrate deploy && node_modules/.bin/next start --port 8117",
    url: "http://localhost:8117/api/health",
    env: {
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      MIGRATE_DATABASE_URL: process.env.E2E_MIGRATE_DATABASE_URL,
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
      AUTH_SECRET: process.env.E2E_AUTH_SECRET,
      // next start is production mode, where Auth.js wants the host it may trust stated.
      AUTH_TRUST_HOST: "true",
      BILLING_PROVIDER: "mock",
      STRIPE_WEBHOOK_SECRET: process.env.E2E_STRIPE_WEBHOOK_SECRET,
    },
    stdout: "pipe",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
