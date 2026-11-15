// Bug: CI job `image`, step "the worker image runs a pass, then stops on SIGTERM with exit 0", pipes
// `docker run ... node dist/worker.mjs --once | tee once.log`. The step has no `shell:` and the workflow no
// `defaults.run.shell`, so GitHub runs it with `bash -e {0}`: no pipefail, the pipeline's status is tee's (0), and
// the worker's exit code is thrown away. Before a1272a5 the bare `docker run` failed the step on exit 1.
// The two greps don't make up for it: when the reminders job throws, scripts/worker.ts `attempt` still logs
// {"job":"reminders","error":...}, then {"worker":"stopped"}, then exits 1, so both greps match.
// Scenario: the real worker (scripts/worker.ts, what dist/worker.mjs bundles) with a reminders pass that fails
// (tally_app loses SELECT on organizations: 42501), run through the step's own lines under `bash -e`.
// Expected: the step fails. Observed: the worker exits 1 and the step exits 0.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const root = join(__dirname, "..", "..");
const owner = process.env.TEST_MIGRATE_DATABASE_URL!;
const app = process.env.TEST_DATABASE_URL!;

function onceLines(): string {
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("\n");
  const at = ci.findIndex((l) => l.includes("name: the worker image runs a pass, then stops on SIGTERM"));
  expect(at).toBeGreaterThan(0);
  const body: string[] = [];
  for (const line of ci.slice(at + 2)) {
    if (line.includes("docker run -d --name worker")) break; // the --once part ends here
    body.push(line.trim());
  }
  return body.join("\n");
}

const psql = (sql: string) => execFileSync("psql", ["-X", "-q", owner, "-c", sql]);
beforeAll(() => psql("REVOKE SELECT ON organizations FROM tally_app"));
afterAll(() => psql("GRANT SELECT ON organizations TO tally_app"));

test("a failing --once pass fails the CI step", () => {
  const script = onceLines();
  // Adapted after the fix: the reviewer's version first asserted the step contained "| tee once.log" (the bug's form),
  // which the fix removed. The rest, the assertion included, is the reviewer's.
  const dir = mkdtempSync(join(tmpdir(), "d5r2-"));
  // The image's command, run from source: the same worker, the same database role.
  const worker = `${join(root, "node_modules/.bin/tsx")} ${join(root, "scripts/worker.ts")} --once`;
  const local = script.replace(/docker run --rm --network host -e DATABASE_URL="\$APP_URL" tally-worker node dist\/worker\.mjs --once/, `(cd ${root} && ${worker})`);
  expect(local).not.toContain("docker");

  const alone = spawnSync("bash", ["-c", `cd ${root} && ${worker}`], { env: { ...process.env, DATABASE_URL: app }, encoding: "utf8" });
  expect(alone.status).toBe(1); // the pass failed, and the worker says so

  const step = spawnSync("bash", ["-e", "-c", local], { cwd: dir, env: { ...process.env, APP_URL: app, DATABASE_URL: app }, encoding: "utf8" });
  expect(step.stdout).toContain('"job":"reminders","error"');
  expect(step.status, `step output:\n${step.stdout}${step.stderr}`).not.toBe(0);
});

// Added after round 3 of day 5 noted the test above would also pass if the step always failed: with the grant back,
// the same lines succeed.
test("a passing --once pass passes the CI step", () => {
  psql("GRANT SELECT ON organizations TO tally_app");
  try {
    const worker = `${join(root, "node_modules/.bin/tsx")} ${join(root, "scripts/worker.ts")} --once`;
    const local = onceLines().replace(/docker run --rm --network host -e DATABASE_URL="\$APP_URL" tally-worker node dist\/worker\.mjs --once/, `(cd ${root} && ${worker})`);
    expect(local).not.toContain("docker");
    const dir = mkdtempSync(join(tmpdir(), "d5r2-ok-"));
    const step = spawnSync("bash", ["-e", "-c", local], { cwd: dir, env: { ...process.env, APP_URL: app, DATABASE_URL: app }, encoding: "utf8" });
    expect(step.status, `step output:\n${step.stdout}${step.stderr}`).toBe(0);
    expect(step.stdout).toContain('"worker":"stopped"');
  } finally {
    psql("REVOKE SELECT ON organizations FROM tally_app");
  }
});
