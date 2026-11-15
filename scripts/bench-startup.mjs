// What the production server costs to start and to keep (README, "Results (day 5)"): the standalone server
// (`npm run build`'s output, what the container image runs) started BENCH_STARTS times; for each start, the time from
// spawn to the first 200 from /api/health (which means the startup check passed: database reachable, role bound by
// row-level security), then BENCH_REQUESTS sign-in page renders and the process's resident memory after them, then
// the time from SIGTERM to exit and the exit code.
//
//   npm run build && node scripts/bench-startup.mjs
//   BENCH_DATABASE_URL (default postgresql://tally_app@localhost:5432/tally_e2e: a migrated database), BENCH_PORT
//   (8137), BENCH_STARTS (5), BENCH_REQUESTS (200)
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const server = ".next/standalone/server.js";
if (!existsSync(server)) {
  console.error(`bench-startup: ${server} is missing; run npm run build first`);
  process.exit(2);
}
const port = Number(process.env.BENCH_PORT ?? 8137);
const starts = Number(process.env.BENCH_STARTS ?? 5);
const requests = Number(process.env.BENCH_REQUESTS ?? 200);
const env = {
  PATH: process.env.PATH ?? "",
  PORT: String(port),
  HOSTNAME: "127.0.0.1",
  DATABASE_URL: process.env.BENCH_DATABASE_URL ?? "postgresql://tally_app@localhost:5432/tally_e2e",
  AUTH_SECRET: randomBytes(32).toString("base64"),
  AUTH_TRUST_HOST: "true",
  BILLING_PROVIDER: "mock",
};

/** Resident set size of a process, in MiB (ps reports KiB). */
const rssMiB = (pid) => Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024;

async function once() {
  const started = performance.now();
  const child = spawn(process.execPath, [server], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: performance.now() })));
  let healthyMs = null;
  while (performance.now() - started < 30_000 && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) {
        healthyMs = performance.now() - started;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(5);
  }
  if (healthyMs === null) {
    child.kill("SIGKILL");
    throw new Error(`the server never answered 200 on /api/health: ${stderr.trim()}`);
  }
  const rssHealthy = rssMiB(child.pid);
  for (let i = 0; i < requests; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/signin`);
    if (response.status !== 200) throw new Error(`/signin answered ${response.status}`);
    await response.arrayBuffer();
  }
  const rssAfter = rssMiB(child.pid);
  const stopAt = performance.now();
  child.kill("SIGTERM");
  const { code, signal, at } = await exited;
  return { healthyMs: Math.round(healthyMs), rssHealthyMiB: Math.round(rssHealthy), rssAfterMiB: Math.round(rssAfter), stopMs: Math.round(at - stopAt), exitCode: code, signal };
}

const runs = [];
for (let i = 0; i < starts; i++) runs.push(await once());
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(
  JSON.stringify(
    {
      node: process.version,
      starts,
      requestsPerStart: requests,
      runs,
      median: { healthyMs: median(runs.map((r) => r.healthyMs)), rssAfterMiB: median(runs.map((r) => r.rssAfterMiB)), stopMs: median(runs.map((r) => r.stopMs)) },
    },
    null,
    2,
  ),
);
