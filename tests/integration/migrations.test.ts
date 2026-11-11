// The migrations themselves: they produce exactly schema.prisma, and the invariants written into them by
// hand (CHECK constraints the schema language can't express) hold.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { appDb, ownerUrl, unique } from "../helpers";

let app: Db;

beforeAll(() => {
  app = appDb({ max: 2 });
});

afterAll(async () => {
  await app.$disconnect();
});

describe("the migrations", () => {
  it("leave the database exactly as schema.prisma describes it", () => {
    // Exits 2 if the migrated database and the schema differ (a model edited without a migration).
    const out = execFileSync(
      "node_modules/.bin/prisma",
      ["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"],
      { env: { ...process.env, MIGRATE_DATABASE_URL: ownerUrl(), PRISMA_HIDE_UPDATE_MESSAGE: "1" }, encoding: "utf8" },
    );
    expect(out).toContain("No difference detected");
  });
});

describe("users", () => {
  const user = (email: string) => app.user.create({ data: { email, name: "N", passwordHash: "x" } });

  it("accept an email in its stored form", async () => {
    await expect(user(`ok-${unique()}@example.com`)).resolves.toMatchObject({ name: "N" });
  });

  it.each([["Upper@Example.com"], [" padded@example.com"], [""]])("refuse an email not in stored form: %j", async (email) => {
    await expect(user(email.replace("@", `-${unique()}@`))).rejects.toThrow(/users_email_normalized/);
  });

  it("refuse a second account with the same email", async () => {
    const email = `dup-${unique()}@example.com`;
    await user(email);
    await expect(user(email)).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("organization slugs", () => {
  const org = (slug: string) => app.organization.create({ data: { name: "N", slug } });

  it.each([["acme"], ["acme-inc"], ["a1-b2-c3"], ["x".repeat(63)]])("accept %s", async (slug) => {
    // Unique per run: only the shape matters here.
    const s = slug.length === 63 ? `${unique()}${slug.slice(12)}` : `${slug}-${unique()}`;
    await expect(org(s)).resolves.toMatchObject({ slug: s });
  });

  it.each([["Acme"], ["acme inc"], ["-acme"], ["acme-"], ["acme--inc"], ["acmé"], ["x".repeat(64)], [""]])(
    "refuse %j",
    async (slug) => {
      await expect(org(slug)).rejects.toThrow(/organizations_slug_format/);
    },
  );
});
