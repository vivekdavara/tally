// An architecture rule, checked over the source: tenant tables are only reached through a withTenant
// transaction (DESIGN.md, "Layer 2"). Row-level security would return nothing for a query on another
// client anyway, but that would be a silent empty page, not an error, so the rule is checked here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const TENANT_MODELS = ["customer", "invoice", "invoiceLine", "payment", "stripeEvent"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every `<receiver>.<tenantModel>.` access in a source text, with its receiver. */
export function tenantAccesses(text: string): { receiver: string; model: string }[] {
  const pattern = new RegExp(`([\\w$.()]+?)\\s*\\.\\s*(${TENANT_MODELS.join("|")})\\s*\\.\\s*\\w+\\s*\\(`, "g");
  return [...text.matchAll(pattern)].map((m) => ({ receiver: m[1]!.split(".").at(-1)!, model: m[2]! }));
}

describe("tenant tables", () => {
  it("are only queried on a withTenant transaction (a receiver named tx)", () => {
    const offenders: string[] = [];
    for (const file of sources(join(ROOT, "src"))) {
      for (const access of tenantAccesses(readFileSync(file, "utf8"))) {
        if (access.receiver !== "tx") offenders.push(`${relative(ROOT, file)}: ${access.receiver}.${access.model}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("are reached through withTenant only from the data access layer (src/server/dal.ts)", () => {
    const callers = sources(join(ROOT, "src"))
      .filter((file) => /\bwithTenant\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file))
      .filter((file) => file !== "src/server/db/tenant.ts")
      .sort();
    expect(callers).toEqual(["src/server/dal.ts"]);
  });

  it("are found by the scan when used the wrong way (the rule can fail)", () => {
    expect(tenantAccesses("const n = await db().customer.count();")).toEqual([{ receiver: "db()", model: "customer" }]);
    expect(tenantAccesses("await client.invoiceLine.findMany({})")).toEqual([{ receiver: "client", model: "invoiceLine" }]);
    expect(tenantAccesses("await tx.invoice.create({ data })")).toEqual([{ receiver: "tx", model: "invoice" }]);
    expect(tenantAccesses("tx.customer\n  .findMany()")).toEqual([{ receiver: "tx", model: "customer" }]);
  });
});
