// `npm start` (scripts/start.mjs) reads the project's env files as `next start` does: .env.local over
// .env.production over .env, $VARIABLE expansion, nothing from .env.development, and the shell's variables over all of
// them; PORT defaults to 8117 and the server listens on every interface. Review round 2 of day 5 found the first
// version (node --env-file-if-exists=.env) read .env alone and didn't expand. A stand-in server.js prints what it got.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

const START = join(import.meta.dirname, "..", "..", "scripts", "start.mjs");
let project: string;

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "tally-start-"));
  mkdirSync(join(project, ".next", "standalone"), { recursive: true });
  const names = ["A", "C", "D", "E", "F", "G", "PORT", "HOSTNAME"];
  writeFileSync(
    join(project, ".next", "standalone", "server.js"),
    `const pick = {}; for (const k of ${JSON.stringify(names)}) pick[k] = process.env[k] ?? null; console.log(JSON.stringify(pick));\n`,
  );
  writeFileSync(join(project, ".env"), ["A=from-env", "B=http://localhost:8117", "C=${B}/paid", "D=from-env", "E=from-env", "G=from-env"].join("\n"));
  writeFileSync(join(project, ".env.production"), "E=from-production\n");
  writeFileSync(join(project, ".env.local"), "D=from-local\n");
  writeFileSync(join(project, ".env.development"), "F=from-development\nG=from-development\n");
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

function start(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [START], {
    cwd: project,
    env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, string | null>;
}

it("reads the files in next start's order, expands variables, and lets the shell win", () => {
  expect(start({ A: "from-shell" })).toEqual({
    A: "from-shell",
    C: "http://localhost:8117/paid",
    D: "from-local",
    E: "from-production",
    F: null,
    G: "from-env",
    PORT: "8117",
    HOSTNAME: "0.0.0.0",
  });
});

it("keeps a PORT the shell sets", () => {
  expect(start({ PORT: "9000" }).PORT).toBe("9000");
});

it("refuses a PORT that isn't a port number, and treats an empty one as unset", () => {
  for (const port of ["0", "abc", " ", "65536", "80x"]) {
    const result = spawnSync(process.execPath, [START], { cwd: project, env: { PATH: process.env.PATH ?? "", PORT: port } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(result.status, port).toBe(2);
    expect(result.stderr).toContain("PORT must be a port number from 1 to 65535");
  }
  expect(start({ PORT: "" }).PORT).toBe("8117");
  expect(start({ PORT: "65535" }).PORT).toBe("65535");
});

it("refuses to start without a build", () => {
  const empty = mkdtempSync(join(tmpdir(), "tally-start-empty-"));
  try {
    const result = spawnSync(process.execPath, [START], { cwd: empty, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("run npm run build first");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
