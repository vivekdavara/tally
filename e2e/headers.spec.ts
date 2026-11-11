import { expect, test } from "@playwright/test";

// The headers next.config.ts sends, on a static page, a dynamic page, an API route and a 404.
for (const path of ["/", "/signin", "/api/health", "/o/no-such-organization"]) {
  test(`security headers on ${path}`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    const headers = response.headers();
    expect(headers["content-security-policy"]).toBe(
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    );
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains");
    expect(headers["x-powered-by"]).toBeUndefined();
  });
}

test("a signed-out visit to a tenant page redirects to sign in, without revealing whether it exists", async ({ request }) => {
  const response = await request.get("/o/no-such-organization", { maxRedirects: 0 });
  expect([303, 307]).toContain(response.status());
  expect(response.headers().location).toMatch(/\/signin$/);
});
