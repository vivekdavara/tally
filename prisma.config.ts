// Prisma CLI configuration. Prisma 7 no longer reads .env by itself; Node's own loader does it here
// (no dotenv dependency), and a missing .env is fine: CI passes the variables in the environment.
import { defineConfig } from "prisma/config";

try {
  process.loadEnvFile();
} catch {
  // No .env file.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations run as the owner role; the application connects as tally_app (DATABASE_URL).
    // `prisma generate` needs no database, so an unset URL is only an error for commands that connect.
    url: process.env.MIGRATE_DATABASE_URL ?? "",
  },
});
