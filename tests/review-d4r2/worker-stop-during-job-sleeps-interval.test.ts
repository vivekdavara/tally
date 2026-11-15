// Review D4 round 2: a stop signal that arrives while a job is running doesn't stop the worker; it sleeps the whole
// interval first.
//
// The bug (scripts/worker.ts): sleep() resolves early by listening for the AbortSignal's "abort" event. An
// AbortSignal fires "abort" once; a listener added after it was aborted is never called. When SIGTERM lands while the
// reminders job runs (the job sees the signal and returns early, as designed), the loop then calls
// sleep(nextReminders - now): the signal is already aborted, the listener never fires, and the worker waits out the
// full REMINDER_INTERVAL_MINUTES (an hour by default) before the `while (!stop.signal.aborted)` check lets it exit.
// A supervisor (systemd, Kubernetes: 30 s grace) SIGKILLs it instead, and a second signal exits 1, not 0.
//
// Scenario: an invoice is a day overdue and the superuser holds its row FOR UPDATE, so the worker's first job blocks in
// the queue step (reminders_guard locks the invoice FOR SHARE). SIGTERM is sent while it is blocked (the worker logs
// "stopping"), then the lock is released: the job queues the reminder, sees the signal and returns.
//
// Expected: the worker logs "stopped" and exits 0 within a few seconds of the job ending (its header: "A stop signal
// lets the current step finish ... and then exits 0").
// Observed: still running 15 s later, asleep for the rest of the 60-minute interval.
import { spawn } from "node:child_process";
import { afterAll, expect, it } from "vitest";
import { db, openInvoice, world } from "../fixtures/org";
import { adminDb, appUrl } from "../helpers";

const admin = adminDb({ max: 2 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), admin.$disconnect()]);
});

it("exits soon after a SIGTERM that arrives during a job", async () => {
  const w = await world("wstop");
  const invoiceId = await openInvoice(w);
  await admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`UPDATE invoices SET due_on = (clock_timestamp() AT TIME ZONE 'UTC')::date - 1 WHERE id = ${invoiceId}::uuid`;
  });

  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const lockHeld = new Promise<void>((resolve) => (locked = resolve));
  const holder = admin.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM invoices WHERE id = ${invoiceId}::uuid FOR UPDATE`;
      locked();
      await released;
    },
    { timeout: 40_000, maxWait: 5_000 },
  );
  await lockHeld;

  const child = spawn("node_modules/.bin/tsx", ["scripts/worker.ts"], {
    env: { ...process.env, DATABASE_URL: appUrl(), REMINDER_INTERVAL_MINUTES: "60", BILLING_PROVIDER: "mock" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // its own process group, so the cleanup below also kills the node process tsx starts
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const until = async (pattern: RegExp, ms: number) => {
    const end = Date.now() + ms;
    while (!pattern.test(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    return pattern.test(out);
  };

  try {
    expect(await until(/"worker":"started"/, 15_000), out).toBe(true);
    await new Promise((r) => setTimeout(r, 500)); // the job is now blocked on the lock
    child.kill("SIGTERM");
    expect(await until(/"worker":"stopping"/, 5_000), out).toBe(true);
    release();
    await holder;
    expect(await until(/"job":"reminders"/, 10_000), out).toBe(true); // the job finished
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("still running after 15 s"), 15_000))]);
    expect(code, out).toBe(0);
  } finally {
    release();
    await holder.catch(() => undefined);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}, 60_000);
