// `npm start`: the standalone server (`npm run build`'s output, what the container image runs) with the project's env
// files, read the way `next start` reads them: Next.js's own loader (@next/env) in production mode, so .env.local,
// .env.production.local, .env.production and .env, in that order of precedence, with $VARIABLE expansion, and a
// variable already set in the environment winning over all of them.
//
// The build deletes the copies of .env that Next.js puts next to server.js (they'd be a snapshot taken at build time,
// secrets included), so this is the only place the files are read. Review round 2 of day 5: the first version passed
// .env alone with `node --env-file-if-exists`, which skips the other files and doesn't expand $VARIABLE.
//
//   npm start            port 8117 unless PORT says otherwise; every IPv4 interface

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
// The standalone server reads PORT as `parseInt(PORT) || 3000`, so 0, "abc" or " " would quietly serve on 3000; next
// start refuses them, and so does this (review round 3 of day 5). Unset or empty means the default.
const port = process.env.PORT ?? "";
if (port === "") {
  process.env.PORT = "8117";
} else if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error(`start: PORT must be a port number from 1 to 65535, not ${JSON.stringify(port)}`);
  process.exit(2);
}
// The standalone server binds to $HOSTNAME, which some shells and every container export as the machine's name.
// 0.0.0.0 is every IPv4 interface. (next start listened on "::", IPv6 too when the machine has it; an explicit "::"
// fails where IPv6 is off, and the server has no way to say "the default". Browsers fall back to 127.0.0.1.)
process.env.HOSTNAME = "0.0.0.0";

await import(pathToFileURL(server).href);
