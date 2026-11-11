// Does sign-in's response time reveal which emails have accounts? (README, "Results")
//
//   scripts/db-setup.sh tally_bench && npx tsx scripts/bench-signin.ts
//
// Times verifyCredentials (the whole sign-in check: validation, the user lookup, scrypt) for three kinds of
// attempt, interleaved in a rotating order: a wrong password for a real account, an email with no account,
// and the right password. If the unknown-email path skipped scrypt it would be ~45 ms faster.
import { cpus, loadavg } from "node:os";
import { verifyCredentials } from "../src/server/auth/credentials";
import { signUpInput } from "../src/server/auth/schemas";
import { signUp } from "../src/server/auth/signup";
import { createDb } from "../src/server/db/client";

const APP_URL = process.env.BENCH_APP_URL ?? "postgresql://tally_app@localhost:5432/tally_bench";
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 200);

function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const monoStart = performance.now();
  const load = loadavg()[0]!;
  const db = createDb(APP_URL, { max: 2 });
  try {
    const tag = `${Date.now().toString(36)}`;
    const input = signUpInput.parse({
      name: "Timing",
      email: `timing-${tag}@example.com`,
      password: "the right password",
      organizationName: `Timing ${tag}`,
    });
    const result = await signUp(input, db);
    if (!result.ok) throw new Error("sign-up failed");
    const attempts = {
      "wrong password": { email: input.email, password: "the wrong password" },
      "unknown email": { email: `nobody-${tag}@example.com`, password: "the right password" },
      "right password": { email: input.email, password: "the right password" },
    };
    const names = Object.keys(attempts) as (keyof typeof attempts)[];
    const samples = new Map(names.map((n) => [n, [] as number[]]));
    for (let i = 0; i < 20 + ROUNDS; i++) {
      for (let k = 0; k < names.length; k++) {
        const name = names[(i + k) % names.length]!;
        const start = performance.now();
        const user = await verifyCredentials(attempts[name], db);
        const ms = performance.now() - start;
        if ((user !== null) !== (name === "right password")) throw new Error(`${name}: unexpected result`);
        if (i >= 20) samples.get(name)!.push(ms);
      }
    }
    const sleptMs = Math.round(Date.now() - wallStart - (performance.now() - monoStart));
    console.log(`${ROUNDS} attempts of each kind (after 20 warm-up), interleaved; ${cpus()[0]?.model}`);
    console.log(`load average ${load.toFixed(2)} at start, slept ${sleptMs} ms during the run`);
    console.log("attempt          p10 ms  p50 ms  p90 ms");
    for (const name of names) {
      const s = [...samples.get(name)!].sort((a, b) => a - b);
      console.log(
        `${name.padEnd(15)} ${percentile(s, 0.1).toFixed(1).padStart(7)} ${percentile(s, 0.5).toFixed(1).padStart(7)} ${percentile(s, 0.9).toFixed(1).padStart(7)}`,
      );
    }
  } finally {
    await db.$disconnect();
  }
}

await main();
