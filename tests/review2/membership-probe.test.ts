// Round 2 probe (passes at e98f346): every Prisma path to another tenant's membership is refused or matches
// nothing (P2025 / count 0 / 42501), including native upsert and nested writes from users and organizations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { withTenant } from "@/server/db/tenant";
import { appDb, unique } from "../helpers";

let app: Db;
let a: { id: string };
let b: { id: string };
let user: { id: string };

beforeAll(async () => {
  app = appDb({ max: 2 });
  const s = unique();
  a = await app.organization.create({ data: { name: `ma ${s}`, slug: `ma-${s}` } });
  b = await app.organization.create({ data: { name: `mb ${s}`, slug: `mb-${s}` } });
  user = await app.user.create({ data: { email: `mu-${s}@example.com`, name: "U", passwordHash: "x" } });
  await withTenant(b.id, (tx) => tx.membership.create({ data: { organizationId: b.id, userId: user.id, role: "MEMBER" } }), app);
});

afterAll(async () => {
  await app.$disconnect();
});

const code = (p: Promise<unknown>) =>
  p.then(
    (v) => `ok ${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x))}`,
    (e: Error & { code?: string }) => `${e.code ?? ""} ${e.message.split("\n").at(-1)}`,
  );

describe("memberships of B from tenant A", () => {
  it("update, updateMany, delete, deleteMany, upsert, nested", async () => {
    const key = { organizationId_userId: { organizationId: b.id, userId: user.id } };
    const results = {
      update: await code(withTenant(a.id, (tx) => tx.membership.update({ where: key, data: { role: "OWNER" } }), app)),
      updateMany: await code(withTenant(a.id, (tx) => tx.membership.updateMany({ where: { organizationId: b.id }, data: { role: "OWNER" } }), app)),
      delete: await code(withTenant(a.id, (tx) => tx.membership.delete({ where: key }), app)),
      deleteMany: await code(withTenant(a.id, (tx) => tx.membership.deleteMany({ where: { organizationId: b.id } }), app)),
      upsert: await code(
        withTenant(a.id, (tx) => tx.membership.upsert({ where: key, create: { organizationId: b.id, userId: user.id, role: "OWNER" }, update: { role: "OWNER" } }), app),
      ),
      nestedFromOrg: await code(
        withTenant(a.id, (tx) => tx.organization.update({ where: { id: b.id }, data: { memberships: { updateMany: { where: {}, data: { role: "OWNER" } } } } }), app),
      ),
      nestedFromUser: await code(
        withTenant(a.id, (tx) => tx.user.update({ where: { id: user.id }, data: { memberships: { deleteMany: {} } } }), app),
      ),
      moveOwn: await code(
        withTenant(a.id, (tx) => tx.membership.updateMany({ where: { organizationId: a.id }, data: { organizationId: b.id } }), app),
      ),
    };
    for (const [k, v] of Object.entries(results)) expect(v, k).not.toMatch(/^ok \{"(count":[1-9]|organizationId)/);
    const m = await app.membership.findUniqueOrThrow({ where: key });
    expect(m.role).toBe("MEMBER");
  });
});
