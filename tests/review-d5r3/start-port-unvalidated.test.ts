// Bug (low severity; round 1's `PORT=${PORT:-8117}` behaved the same): scripts/start.mjs (`npm start`) promises
// "port 8117 unless PORT says otherwise", but passes any non-empty PORT through unchecked to the standalone server,
// whose generated server.js (next/dist/build/utils.js) computes `parseInt(process.env.PORT, 10) || 3000`. So PORT=0,
// PORT=abc or PORT=" " silently serve on 3000, a port nobody asked for; `next start` parses PORT with
// parseValidPositiveInteger (next/dist/bin/next, `.env('PORT')`) and refuses such a value instead.
// Scenario: start.mjs with a stand-in server.js whose port line is copied verbatim from Next.js's standalone template
// (the test checks the line is still there), PORT=0 / abc / " ".
// Expected: 8117 (the documented default) or a refusal. Observed: the server's port is 3000.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const START = join(root, "scripts", "start.mjs");
const PORT_LINE = "const currentPort = parseInt(process.env.PORT, 10) || 3000";
let project: string;

beforeAll(() => {
  const template = readFileSync(join(root, "node_modules/next/dist/build/utils.js"), "utf8");
  expect(template).toContain(PORT_LINE); // the real standalone server.js's port logic
  project = mkdtempSync(join(tmpdir(), "tally-d5r3-port-"));
  mkdirSync(join(project, ".next", "standalone"), { recursive: true });
  writeFileSync(join(project, ".next", "standalone", "server.js"), `${PORT_LINE}\nconsole.log(JSON.stringify({ port: currentPort }));\n`);
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

it.each(["0", "abc", " "])("PORT=%j: 8117 or a refusal, not 3000", (port) => {
  const result = spawnSync(process.execPath, [START], {
    cwd: project,
    // Adapted: cast for typecheck (Next.js's types make NODE_ENV a required variable); the values are the reviewer's.
    env: { PATH: process.env.PATH ?? "", PORT: port } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  if (result.status !== 0) return; // a refusal is acceptable
  const { port: served } = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { port: number };
  expect(served).toBe(8117);
});
