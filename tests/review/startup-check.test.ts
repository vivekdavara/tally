// The startup check (src/instrumentation-node.ts), run as a module with process.exit stubbed.
//
// The first test passes: as tally_owner the module calls process.exit(1), as intended (nothing in the
// original suite exercises this file; deleting the process.exit(1) line leaves every test green).
//
// REVIEW FINDING (minor, the second test): the check has no time limit. pg's connectionTimeoutMillis
// defaults to 0 (wait forever) and Prisma adds none, so if the database accepts the TCP connection but never
// answers (a stuck proxy, a half-open connection, a server in recovery behind a load balancer), the import
// never settles. Next.js has already bound the port and holds every request until instrumentation finishes,
// so the process neither exits nor serves: the "supervisor counts it as running" state the module's comment
// sets out to prevent.
//
// Suggested fix: race the check against a timer (e.g. 10 s) and exit(1) when it fires, or pass
// connectionTimeoutMillis (and a statement_timeout) to the pool used for the check.
import { createServer, type Server, type Socket } from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@/server/db/client";
import { assertSafeAppRole } from "@/server/db/role-check";
import { ownerUrl } from "../helpers";

const cache = globalThis as unknown as { tallyDb?: { $disconnect(): Promise<void> } };

afterAll(async () => {
  await cache.tallyDb?.$disconnect();
  delete cache.tallyDb;
});

describe("the startup check", () => {
  it("exits with status 1 when the role could bypass row-level security", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const previous = process.env.DATABASE_URL;
    delete cache.tallyDb;
    process.env.DATABASE_URL = ownerUrl();
    try {
      await import("@/instrumentation-node");
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.mock.calls[0]?.join(" ")).toMatch(/not starting: refusing to serve: .*tally_owner owns/);
    } finally {
      process.env.DATABASE_URL = previous;
      exit.mockRestore();
      log.mockRestore();
    }
  });

  it("settles (one way or the other) when the database accepts connections but never answers", async () => {
    // A local server that accepts TCP connections and then says nothing.
    const sockets: Socket[] = [];
    const silent: Server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as { port: number }).port;
    const client = createDb(`postgresql://tally_app@127.0.0.1:${port}/tally_test`, { max: 1 });
    try {
      const outcome = await Promise.race([
        assertSafeAppRole(client).then(
          () => "passed",
          () => "refused",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 10_000)),
      ]);
      // Observed: "still waiting" (and it would wait forever).
      expect(outcome).not.toBe("still waiting");
    } finally {
      for (const s of sockets) s.destroy();
      silent.close();
      void client.$disconnect().catch(() => undefined);
    }
  }, 20_000);
});
