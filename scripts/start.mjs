// `npm start`: the standalone server (`npm run build`'s output, what the container image runs) with the project's env
// files, read the way `next start` reads them: Next.js's own loader (@next/env) in production mode, so .env.local,
// .env.production.local, .env.production and .env, in that order of precedence, with $VARIABLE expansion, and a
// variable already set in the environment winning over all of them.
//
// The build deletes the copies of .env that Next.js puts next to server.js (they'd be a snapshot taken at build time,
// secrets included), so this is the only place the files are read. Review round 2 of day 5: the first version passed
// .env alone with `node --env-file-if-exists`, which skips the other files and doesn't expand $VARIABLE.
//
//   npm start            port 8117 unless PORT says otherwise; every interface, like next start

// A CommonJS module whose exports Node can't see statically: import the whole of it.
import nextEnv from "@next/env";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const project = process.cwd();
const server = join(project, ".next", "standalone", "server.js");
if (!existsSync(server)) {
  console.error("start: .next/standalone/server.js is missing; run npm run build first");
  process.exit(2);
}

nextEnv.loadEnvConfig(project, false);
process.env.PORT ||= "8117";
// The standalone server binds to $HOSTNAME, which some shells and every container export as the machine's name;
// next start listened on every interface, and so does this.
process.env.HOSTNAME = "0.0.0.0";

await import(pathToFileURL(server).href);
