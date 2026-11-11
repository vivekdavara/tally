import { describe, expect, it } from "vitest";
import { jwtCallback, sessionCallback } from "@/server/auth/session-callbacks";

describe("jwtCallback", () => {
  it("keeps only the user id and the token's own times, dropping the profile Auth.js adds", () => {
    const token = { sub: "old", name: "Ada", email: "ada@example.com", picture: "p.png", iat: 1, exp: 2, jti: "j", role: "OWNER" };
    expect(jwtCallback({ token, user: { id: "user-1" } })).toEqual({ sub: "user-1", iat: 1, exp: 2, jti: "j" });
  });

  it("keeps the existing subject on later calls, which have no user", () => {
    expect(jwtCallback({ token: { sub: "user-1", email: "x", iat: 3, exp: 4, jti: "k" } })).toEqual({
      sub: "user-1",
      iat: 3,
      exp: 4,
      jti: "k",
    });
  });
});

describe("sessionCallback", () => {
  it("exposes the token's subject as session.user.id", () => {
    expect(sessionCallback({ session: { user: {} }, token: { sub: "user-1" } })).toEqual({ user: { id: "user-1" } });
  });
});
