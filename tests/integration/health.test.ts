import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/server/db/client";
import { checkHealth } from "@/server/health";
import { appDb, ownerDb } from "../helpers";

let app: Db;
let owner: Db;

beforeAll(() => {
  app = appDb({ max: 1 });
  owner = ownerDb({ max: 1 });
});

afterAll(async () => {
  await Promise.all([app.$disconnect(), owner.$disconnect()]);
});

describe("checkHealth", () => {
  it("is ok as tally_app", async () => {
    expect(await checkHealth(app)).toEqual({ httpStatus: 200, body: { status: "ok" } });
  });

  it("is unavailable as a role that bypasses isolation, and says why only in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await checkHealth(owner)).toEqual({ httpStatus: 503, body: { status: "unavailable" } });
      expect(log.mock.calls[0]?.join(" ")).toMatch(/tally_owner owns/);
    } finally {
      log.mockRestore();
    }
  });

  it("is unavailable when the database can't be reached", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const nowhere = (await import("@/server/db/client")).createDb("postgresql://tally_app@127.0.0.1:1/tally_test", { max: 1 });
    try {
      expect((await checkHealth(nowhere)).httpStatus).toBe(503);
    } finally {
      log.mockRestore();
      await nowhere.$disconnect();
    }
  });
});
