import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

export type Db = PrismaClient;

/** A Prisma client over its own `pg` pool. `max` bounds the pool's connections. */
export function createDb(connectionString: string, options: { max?: number } = {}): Db {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: options.max ?? 10 }),
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
