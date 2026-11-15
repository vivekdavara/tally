// Tenant isolation across every route (DESIGN.md, "Tenant isolation"; day 4's suite). Every page, route handler and
// Server Action under src/app is listed here (a test fails when one is added without a probe), and each is called as
// the *owner* of another organization, B, against organization A: with A's slug (the uniform 404), and with B's own
// slug and A's ids (not found, nothing changed). B's own pages are checked to contain none of A's data, and A's rows
// are compared before and after all of it. The session is mocked; everything else is the real code against Postgres.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { invite } from "@/server/orgs/members";
import { db, draft, formData, openInvoice, outcome, person, sessions, signInAs, world, addMember, type Outcome, type World } from "../fixtures/org";
import { adminDb } from "../helpers";

vi.mock("@/auth", () => ({ auth: async () => sessions.current, signIn: async () => {}, signOut: async () => {} }));
// src/app/actions.ts imports next-auth itself (for AuthError), which Vitest can't load outside Next.js.
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ROOT = join(import.meta.dirname, "..", "..");
const APP = join(ROOT, "src", "app");
const admin = adminDb({ max: 2 });

afterAll(async () => {
  await Promise.all([db().$disconnect(), admin.$disconnect()]);
});

// The victim, A, with something of every kind; the attacker, B's owner.
let A: World;
let B: World;
let a: { draftId: string; lineId: string; openId: string; openId2: string; invitationId: string; invitationToken: string; markers: string[] };

beforeAll(async () => {
  A = await world("victim");
  B = await world("attacker");
  const marker = `zq${Date.now().toString(36)}`;
  const customerId = await A.run(async (tx) => (await tx.customer.create({ data: { organizationId: A.organizationId, name: `Secret Customer ${marker}`, email: `secret-${marker}@victim.example` } })).id);
  const { invoiceId: draftId, lineId } = await draft(A);
  await A.run((tx) => tx.invoice.update({ where: { id: draftId }, data: { memo: `secret memo ${marker}`, customerId } }));
  const openId = await openInvoice(A);
  const openId2 = await openInvoice(A);
  const invited = await A.run((tx) => invite(tx, A.owner.userId, `invitee-${marker}@victim.example`, "ADMIN"));
  if (!invited.ok) throw new Error(invited.reason);
  a = {
    draftId,
    lineId,
    openId,
    openId2,
    invitationId: invited.value.id,
    invitationToken: invited.value.token,
    markers: [marker, A.name, A.member.email, A.admin.email, A.owner.email, A.slug],
  };
});

/** Every row of A in every table that holds A's data, as the superuser sees it (no row security). */
async function snapshotA(): Promise<unknown> {
  const tables = ["customers", "invoices", "invoice_lines", "invoice_counters", "payments", "stripe_events", "invitations", "reminders", "memberships"];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    out[t] = await admin.$queryRawUnsafe(`SELECT to_jsonb(t)::text AS row FROM ${t} t WHERE organization_id = $1::uuid ORDER BY 1`, A.organizationId);
  }
  out.organization = await admin.$queryRaw`SELECT to_jsonb(o)::text AS row FROM organizations o WHERE id = ${A.organizationId}::uuid`;
  return out;
}

/**
 * Every string, number and date in a page's returned element tree (React elements by their props only; React's dev
 * fields hold cycles), joined: for "does any of A's data appear?".
 */
function text(o: Outcome): string {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 80 || v === null || v === undefined) return;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") out.push(String(v));
    else if (v instanceof Date) out.push(v.toISOString());
    else if (typeof v === "object") {
      if (seen.has(v)) return;
      seen.add(v);
      if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
      else if ("$$typeof" in v) walk((v as { props?: unknown }).props, depth + 1);
      else for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(o, 0);
  return out.join("\n");
}

const leaks = (o: Outcome) => a.markers.filter((m) => text(o).includes(m));
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });

// Every route, by its path under src/app. `probe` runs as B's owner; `public` explains a route with no tenant data.
type Probe = { probe: () => Promise<void> } | { public: string };

async function pageOf(path: string) {
  return (await import(`@/app/${path}`)) as { default: (props: unknown) => Promise<unknown>; generateMetadata?: (props: unknown) => Promise<unknown> };
}

async function tenantPage(path: string, ids: Record<string, string> = {}) {
  const page = await pageOf(path);
  signInAs(B.owner);
  // A's slug: the same 404 as a slug that doesn't exist, for the page and for its title (generateMetadata runs on its
  // own, from the first membership lookup only).
  expect(await outcome(page.default(params({ slug: A.slug, ...ids })))).toEqual({ notFound: true });
  if (page.generateMetadata) expect(await outcome(page.generateMetadata(params({ slug: A.slug, ...ids })))).toEqual({ notFound: true });
  if (Object.keys(ids).length > 0) {
    // B's slug with A's ids: row security finds nothing.
    expect(await outcome(page.default(params({ slug: B.slug, ...ids })))).toEqual({ notFound: true });
  } else {
    // B's own page: none of A's data.
    const own = await outcome(page.default(params({ slug: B.slug })));
    expect("value" in own, text(own).slice(0, 200)).toBe(true);
    expect(leaks(own)).toEqual([]);
  }
}

const ROUTES: Record<string, Probe> = {
  "page.tsx": { public: "the landing page: no data" },
  "signin/page.tsx": { public: "the sign-in form" },
  "signup/page.tsx": { public: "the sign-up form" },
  "paid/page.tsx": { public: "checkout's return page: says nothing about any invoice" },
  "api/auth/[...nextauth]/route.ts": { public: "Auth.js's own endpoints (sign-in, sign-out, session): identity only, no tenant data" },
  "api/health/route.ts": {
    async probe() {
      const { GET } = (await import("@/app/api/health/route")) as { GET: () => Promise<Response> };
      const body = await (await GET()).text();
      expect(a.markers.filter((m) => body.includes(m))).toEqual([]);
    },
  },
  "api/stripe/webhook/route.ts": {
    async probe() {
      // The webhook has no session: the signed event names the tenant. An event naming B for A's checkout session is
      // proven harmless in billing.test.ts; this checks that test is still there.
      const billing = readFileSync(join(ROOT, "tests", "integration", "billing.test.ts"), "utf8");
      expect(billing).toContain(`it("can't touch another organization's payment by naming it in the metadata"`);
    },
  },
  "o/page.tsx": {
    async probe() {
      const page = await pageOf("o/page.tsx");
      signInAs(B.owner);
      // B's owner belongs to one organization (B), so the list redirects there.
      expect(await outcome(page.default({}))).toEqual({ redirect: `/o/${B.slug}` });
    },
  },
  "o/[slug]/page.tsx": { probe: () => tenantPage("o/[slug]/page.tsx") },
  "o/[slug]/customers/page.tsx": { probe: () => tenantPage("o/[slug]/customers/page.tsx") },
  "o/[slug]/customers/[id]/page.tsx": { probe: () => tenantPage("o/[slug]/customers/[id]/page.tsx", { id: A.customerId }) },
  "o/[slug]/invoices/page.tsx": { probe: () => tenantPage("o/[slug]/invoices/page.tsx") },
  "o/[slug]/invoices/[id]/page.tsx": {
    async probe() {
      await tenantPage("o/[slug]/invoices/[id]/page.tsx", { id: a.draftId });
      await tenantPage("o/[slug]/invoices/[id]/page.tsx", { id: a.openId });
    },
  },
  "o/[slug]/invoices/[id]/pdf/route.ts": {
    async probe() {
      const { GET } = (await import("@/app/o/[slug]/invoices/[id]/pdf/route")) as { GET: (r: Request, c: unknown) => Promise<Response> };
      signInAs(B.owner);
      const request = new Request("http://localhost:8117/");
      expect(await outcome(GET(request, params({ slug: A.slug, id: a.openId })))).toEqual({ notFound: true });
      const own = await GET(request, params({ slug: B.slug, id: a.openId }));
      expect(own.status).toBe(404);
    },
  },
  "o/[slug]/members/page.tsx": { probe: () => tenantPage("o/[slug]/members/page.tsx") },
  "invite/[token]/page.tsx": {
    async probe() {
      const page = await pageOf("invite/[token]/page.tsx");
      signInAs(B.owner);
      // A real link, the wrong account: no way in, and the page says only that.
      const wrong = await outcome(page.default(params({ token: a.invitationToken })));
      expect(text(wrong)).toContain("wrong-email");
      expect(text(wrong)).not.toContain("accept-invitation");
      // A's secret under B's organization id: nothing.
      const [, secret] = a.invitationToken.split(".");
      expect(await outcome(page.default(params({ token: `${B.organizationId}.${secret}` })))).toEqual({ notFound: true });
    },
  },
  "mock-checkout/[id]/page.tsx": {
    async probe() {
      // Public, like Stripe's hosted page: the session id is the capability (128-bit random). An id the mock didn't
      // issue is a 404.
      const page = await pageOf("mock-checkout/[id]/page.tsx");
      expect(await outcome(page.default(params({ id: "cs_test_0000000000000000000000000000" })))).toEqual({ notFound: true });
    },
  },
};

/** Every page.tsx and route.ts under src/app, as paths relative to it. */
function routeFiles(dir = APP): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return name === "page.tsx" || name === "route.ts" ? [relative(APP, path)] : [];
  });
}

/** Every "use server" module under src/app. */
function serverActionFiles(dir = APP): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return serverActionFiles(path);
    return /\.tsx?$/.test(name) && /^\s*["']use server["']/.test(readFileSync(path, "utf8")) ? [relative(APP, path)] : [];
  });
}

describe("every route", () => {
  it("has a probe or a reason it holds no tenant data", () => {
    expect(routeFiles().sort()).toEqual(Object.keys(ROUTES).sort());
  });

  for (const [route, probe] of Object.entries(ROUTES)) {
    if ("probe" in probe) it(`${route}: nothing of another organization`, probe.probe);
  }
});

// Server Actions, by module and name. Each gets A's slug (404) and, where it takes ids, B's slug with A's ids.
type ActionProbe = { slugOnly: () => Promise<unknown> } | { withIds: (slug: string) => Promise<unknown> } | { public: string } | { probe: () => Promise<void> };

const tenantActions = async () => ({
  ...(await import("@/app/o/[slug]/actions")),
  ...(await import("@/app/o/[slug]/members/actions")),
});

const ACTIONS: Record<string, Record<string, ActionProbe>> = {
  "actions.ts": {
    signUpAction: { public: "creates a new user and organization; takes no tenant input" },
    signInAction: { public: "identity only" },
    signOutAction: { public: "identity only" },
  },
  "o/[slug]/actions.ts": {
    createCustomerAction: { slugOnly: async () => (await tenantActions()).createCustomerAction(A.slug, {}, formData({ name: "x", email: "x@example.com", address: "" })) },
    updateCustomerAction: { withIds: async (slug) => (await tenantActions()).updateCustomerAction(slug, A.customerId, {}, formData({ name: "Taken", email: "taken@example.com", address: "" })) },
    deleteCustomerAction: { withIds: async (slug) => (await tenantActions()).deleteCustomerAction(slug, A.customerId) },
    createDraftAction: { withIds: async (slug) => (await tenantActions()).createDraftAction(slug, {}, formData({ customerId: A.customerId, currency: "USD", memo: "x" })) },
    updateDraftAction: { withIds: async (slug) => (await tenantActions()).updateDraftAction(slug, a.draftId, {}, formData({ customerId: A.customerId, memo: "taken" })) },
    addLineAction: { withIds: async (slug) => (await tenantActions()).addLineAction(slug, a.draftId, {}, formData({ description: "x", quantity: "1", unitPrice: "1.00", taxRate: "0" })) },
    removeLineAction: { withIds: async (slug) => (await tenantActions()).removeLineAction(slug, a.draftId, a.lineId) },
    deleteDraftAction: { withIds: async (slug) => (await tenantActions()).deleteDraftAction(slug, a.draftId) },
    finalizeAction: { withIds: async (slug) => (await tenantActions()).finalizeAction(slug, a.draftId, {}, formData({ netDays: "1" })) },
    markPaidAction: { withIds: async (slug) => (await tenantActions()).markPaidAction(slug, a.openId) },
    voidAction: { withIds: async (slug) => (await tenantActions()).voidAction(slug, a.openId2) },
    collectPaymentAction: { withIds: async (slug) => (await tenantActions()).collectPaymentAction(slug, a.openId) },
  },
  "o/[slug]/members/actions.ts": {
    inviteAction: { slugOnly: async () => (await tenantActions()).inviteAction(A.slug, {}, formData({ email: "new@example.com", role: "OWNER" })) },
    changeRoleAction: { withIds: async (slug) => (await tenantActions()).changeRoleAction(slug, A.member.userId, {}, formData({ role: "OWNER" })) },
    removeMemberAction: { withIds: async (slug) => (await tenantActions()).removeMemberAction(slug, A.owner.userId) },
    revokeInvitationAction: { withIds: async (slug) => (await tenantActions()).revokeInvitationAction(slug, a.invitationId) },
    leaveOrganizationAction: { slugOnly: async () => (await tenantActions()).leaveOrganizationAction(A.slug) },
  },
  "invite/[token]/actions.ts": {
    acceptInvitationAction: {
      async probe() {
        const { acceptInvitationAction } = await import("@/app/invite/[token]/actions");
        signInAs(B.owner);
        expect(await outcome(acceptInvitationAction(a.invitationToken))).toMatchObject({ state: { error: expect.stringMatching(/different email address/) } });
        const [, secret] = a.invitationToken.split(".");
        expect(await outcome(acceptInvitationAction(`${B.organizationId}.${secret}`))).toMatchObject({ state: { error: expect.stringMatching(/isn't valid/) } });
      },
    },
  },
  "mock-checkout/actions.ts": Object.fromEntries(
    ["payByCardAction", "payByBankAction", "lapseAction", "redeliverAction", "settleAction"].map((name) => [
      name,
      {
        async probe() {
          // Public like the page: the session id is the capability; an id the mock didn't issue is a 404.
          const mod = (await import("@/app/mock-checkout/actions")) as unknown as Record<string, (id: string, ...rest: unknown[]) => Promise<unknown>>;
          expect(await outcome(mod[name]!("cs_test_0000000000000000000000000000", true))).toEqual({ notFound: true });
        },
      },
    ]),
  ),
};

describe("every Server Action", () => {
  it("has a probe or a reason it takes no tenant input", async () => {
    expect(serverActionFiles().sort()).toEqual(Object.keys(ACTIONS).sort());
    for (const file of Object.keys(ACTIONS)) {
      const mod = (await import(`@/app/${file}`)) as Record<string, unknown>;
      const exported = Object.entries(mod)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
        .sort();
      expect(exported, file).toEqual(Object.keys(ACTIONS[file]!).sort());
    }
  });

  for (const [file, actions] of Object.entries(ACTIONS)) {
    for (const [name, probe] of Object.entries(actions)) {
      if ("public" in probe) continue;
      it(`${file} ${name}: refuses another organization's owner and changes nothing of A`, async () => {
        const before = await snapshotA();
        signInAs(B.owner);
        if ("probe" in probe) {
          await probe.probe();
        } else if ("slugOnly" in probe) {
          expect(await outcome(probe.slugOnly())).toEqual({ notFound: true });
        } else {
          expect(await outcome(probe.withIds(A.slug))).toEqual({ notFound: true });
          // B's own slug with A's ids: an error (not found, or the customer isn't in the list), never success.
          const own = await outcome(probe.withIds(B.slug));
          expect(own, JSON.stringify(own)).toMatchObject({ state: { error: expect.any(String) } });
        }
        expect(await snapshotA()).toEqual(before);
      });
    }
  }
});

describe("the members list", () => {
  it("never shows another organization's members, although memberships are readable across organizations", async () => {
    // Someone in both organizations sees each list with only its own members.
    const both = await person("both");
    await addMember(A.organizationId, both.userId, "MEMBER");
    await addMember(B.organizationId, both.userId, "MEMBER");
    const page = await pageOf("o/[slug]/members/page.tsx");
    signInAs(both);
    const ofB = text(await outcome(page.default(params({ slug: B.slug }))));
    expect(ofB).toContain(B.owner.email);
    expect(a.markers.filter((m) => ofB.includes(m))).toEqual([]);
  });
});
