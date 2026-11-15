// Bundles the long-running commands that aren't part of the Next.js server into single files under dist/, so the
// container image runs them with plain `node` and needs neither TypeScript, tsx nor the source tree:
//
//   dist/worker.mjs      the background worker (scripts/worker.ts): overdue reminders, reconciliation in Stripe mode
//   dist/reconcile.mjs   one reconciliation pass over Stripe's recent events (scripts/reconcile.ts)
//
// Every dependency is bundled in, Prisma's query compiler included (it ships as a base64 JS module, imported
// dynamically with a literal path, which esbuild follows). The `@/` imports resolve through tsconfig.json's paths.
//
//   node scripts/build-worker.mjs [outdir, default dist]     (npm run build:worker; npm run build runs it too)
import { build } from "esbuild";

const outdir = process.argv[2] ?? "dist";

await build({
  entryPoints: { worker: "scripts/worker.ts", reconcile: "scripts/reconcile.ts" },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  // The oldest Node the project supports (package.json engines).
  target: "node22.12",
  // pg loads its optional native binding only if asked to (`pg.native`); Tally never is, and it isn't installed.
  external: ["pg-native"],
  // Bundled CommonJS packages (pg among them) call require() for Node's built-ins, which an ES module doesn't have.
  banner: { js: "import { createRequire as __tallyCreateRequire } from 'node:module';\nconst require = __tallyCreateRequire(import.meta.url);" },
  sourcemap: "linked",
  logLevel: "warning",
});
