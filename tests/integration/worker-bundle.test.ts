// The bundled worker (scripts/build-worker.mjs), the file the container image runs: built into a temporary directory
// with no node_modules above it, so any import the bundle left unresolved fails here instead of in production. It must
// send an overdue invoice's reminder, refuse a role that row-level security doesn't bind, and stop cleanly on SIGTERM
// (what `docker stop` and Kubernetes send) while it sleeps between runs.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db, openInvoice, world } from "../fixtures/org";
import { adminDb, appUrl, ownerUrl } from "../helpers";

const admin = adminDb({ max: 2 });
let dir: string;

beforeAll(() => {
  const build = mkdtempSync(join(tmpdir(), "tally-bundle-build-"));
  const result = spawnSync(process.execPath, ["scripts/build-worker.mjs", build], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  // Copied out of the build directory alone: only the bundles, nothing esbuild could have resolved against.
  dir = mkdtempSync(join(tmpdir(), "tally-bundle-run-"));
  for (const file of ["worker.mjs", "reconcile.mjs"]) cpSync(join(build, file), join(dir, file));
  rmSync(build, { recursive: true, force: true });
}, 60_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await Promise.all([db().$disconnect(), admin.$disconnect()]);
});

/** Only PATH and the variables given: no inherited DATABASE_URL (and no .env: the bundles run with cwd `dir`). */
function bare(env: Record<string, string>): NodeJS.ProcessEnv {
  // A cast: Next.js's types make NODE_ENV a required variable, and these processes deliberately don't get one.
  return { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv;
}

/** Runs a bundle to completion. */
function run(file: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [join(dir, file), ...args], {
    cwd: dir,
    env: bare(env),
    encoding: "utf8",
    timeout: 30_000,
  });
}

it("sends an overdue invoice's reminder in one pass and exits 0", async () => {
  const w = await world("bundle");
  const invoiceId = await openInvoice(w);
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - 1 WHERE id = ${invoiceId}::uuid`;
  });

  const result = run("worker.mjs", ["--once"], { DATABASE_URL: appUrl(), BILLING_PROVIDER: "mock" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ worker: "started", once: true });
  expect(lines.at(-1)).toMatchObject({ worker: "stopped" });
  const mail = lines.filter((line) => line.mail).map((line) => line.mail as { subject: string });
  expect(mail.filter((m) => m.subject.includes(`from ${w.name} is 1 day overdue`))).toHaveLength(1);

  const sent = await w.run((tx) => tx.reminder.findMany({ where: { invoiceId }, select: { stage: true, sentAt: true } }));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.sentAt).not.toBeNull();
});

it("refuses the owner role, as the server does", () => {
  const result = run("worker.mjs", ["--once"], { DATABASE_URL: ownerUrl(), BILLING_PROVIDER: "mock" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("refusing to serve");
});

it("names the missing setting instead of crashing", () => {
  const result = run("worker.mjs", ["--once"], {});
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("DATABASE_URL is not set");
});

it("the reconcile bundle runs and explains that it needs Stripe mode", () => {
  const result = run("reconcile.mjs", [], { DATABASE_URL: appUrl(), BILLING_PROVIDER: "mock" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("needs BILLING_PROVIDER=stripe");
});

it("stops with exit 0 on SIGTERM while sleeping between runs", async () => {
  const child = spawn(process.execPath, [join(dir, "worker.mjs")], {
    cwd: dir,
    env: bare({ DATABASE_URL: appUrl(), BILLING_PROVIDER: "mock", REMINDER_INTERVAL_MINUTES: "60" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const end = Date.now() + 20_000;
    while (!/"job":"reminders"/.test(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(out).toMatch(/"job":"reminders"/); // the first run is done; it now sleeps for an hour
    const sent = Date.now();
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running after 5 s"), 5_000))]);
    expect(code, out).toBe(0);
    expect(Date.now() - sent).toBeLessThan(5_000);
    expect(out).toMatch(/"worker":"stopped"/);
  } finally {
    child.kill("SIGKILL");
  }
}, 30_000);
