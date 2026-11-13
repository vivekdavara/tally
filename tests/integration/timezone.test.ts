// Times survive the trip through Prisma whatever the database's own time zone. Prisma 7.10's pg adapter sends a
// Date without its zone and reads a timestamptz as if it were UTC, so the application's connections must run in
// UTC (src/server/db/client.ts). The test database's default time zone is New York (tests/global-setup.ts), so
// these fail if the client stops setting it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { adminDb, appDb, unique } from "../helpers";

let app: Db;
let admin: Db;

beforeAll(() => {
  app = appDb({ max: 2 });
  admin = adminDb({ max: 1 });
});

afterAll(async () => {
  await app.$disconnect();
  await admin.$disconnect();
});

describe("time zones", () => {
  it("the test database's default isn't UTC (or these tests prove nothing)", async () => {
    const rows = await admin.$queryRaw<{ tz: string }[]>`SELECT setting AS tz FROM pg_settings WHERE name = 'TimeZone'`;
    const dbDefault = await admin.$queryRaw<{ cfg: string[] | null }[]>`
      SELECT setconfig AS cfg FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole = 0`;
    expect(dbDefault[0]?.cfg ?? []).toContain("TimeZone=America/New_York");
    expect(rows).toHaveLength(1);
  });

  it("the application's connections run in UTC", async () => {
    const rows = await app.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(rows[0]!.tz).toBe("UTC");
  });

  it("a database time read through Prisma is the real time", async () => {
    const before = Date.now();
    const rows = await app.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
    expect(Math.abs(rows[0]!.t.getTime() - before)).toBeLessThan(5_000);
  });

  it("a Date written through Prisma is stored as that instant, and reads back the same", async () => {
    const org = await app.organization.create({ data: { name: "TZ", slug: `tz-${unique()}` } });
    const echo = await app.$queryRaw<{ utc: string }[]>`SELECT to_char(${new Date("2026-11-13T12:00:00.000Z")}::timestamptz AT TIME ZONE 'UTC', 'HH24:MI') AS utc`;
    expect(echo[0]!.utc).toBe("12:00");
    const created = await admin.$queryRaw<{ ms: number }[]>`SELECT (extract(epoch FROM created_at) * 1000)::float8 AS ms FROM organizations WHERE id = ${org.id}::uuid`;
    expect(Math.abs(created[0]!.ms - org.createdAt.getTime())).toBeLessThan(1);
  });
});
