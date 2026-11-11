// Separate file: vi.mock replaces the slug module for the whole file.
import { afterAll, describe, expect, it, vi } from "vitest";
import { signUpInput } from "@/server/auth/schemas";
import { signUp } from "@/server/auth/signup";
import { appDb, unique } from "../helpers";

vi.mock("@/server/orgs/slug", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/orgs/slug")>();
  // Every "random" suffix is the same, so after the first collision every retry collides too.
  return { ...original, randomSuffix: () => "aaaaaa" };
});

const app = appDb({ max: 2 });

afterAll(async () => {
  await app.$disconnect();
});

describe("signUp when every slug is taken", () => {
  it("gives up after five attempts with an error, and creates no user", async () => {
    const name = `Crowded ${unique()}`;
    const base = name.toLowerCase().replace(" ", "-");
    await app.organization.createMany({ data: [{ name, slug: base }, { name, slug: `${base}-aaaaaa` }] });
    const email = `crowded-${unique()}@example.com`;
    const data = signUpInput.parse({ name: "N", email, password: "long enough!", organizationName: name });
    await expect(signUp(data, app)).rejects.toThrow(/no free slug for "crowded-[0-9a-f]+" after 5 attempts/);
    expect(await app.user.count({ where: { email } })).toBe(0);
  });
});
