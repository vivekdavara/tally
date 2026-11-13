import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

export type Db = PrismaClient;

/**
 * A Prisma client over its own `pg` pool. `max` bounds the pool's connections. Connecting gives up after
 * five seconds (pg's default is to wait forever): a database that accepts the TCP connection but never
 * answers would otherwise hang the startup check, and every request, indefinitely.
 *
 * Every connection runs with TimeZone=UTC. Prisma 7.10's pg adapter drops the zone both ways: it sends a Date
 * as a timestamp without one (Postgres reads it in the session's time zone) and reads a timestamptz back as if
 * its offset were +00. On a UTC server that's invisible; on this Mac's New York cluster every time was five
 * hours off, in the database and on the page (found on day 3; tests/integration/timezone.test.ts).
 */
export function createDb(connectionString: string, options: { max?: number; connectTimeoutMs?: number } = {}): Db {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 5_000,
      options: "-c TimeZone=UTC",
    }),
  });
}

const cache = globalThis as unknown as { tallyDb?: Db };

/**
 * The application's client, connected as tally_app (DATABASE_URL). Created on first use, and cached on
 * globalThis so that Next.js's development reloads reuse one pool instead of opening a new one per reload.
 */
export function db(): Db {
  if (!cache.tallyDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set (see .env.example)");
    }
    cache.tallyDb = createDb(url);
  }
  return cache.tallyDb;
}
