// Auth.js's jwt and session callbacks (src/auth.ts), here so they can be tested without Auth.js.
// The cookie carries only the user's id (`sub`) and the token's own times: everything a user may do is
// read from the database on each request (DESIGN.md, "Authentication").

export interface Token {
  sub?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  [claim: string]: unknown;
}

export function jwtCallback({ token, user }: { token: Token; user?: { id?: string | null } | null }): Token {
  const sub = user?.id ?? token.sub;
  return { sub, iat: token.iat, exp: token.exp, jti: token.jti };
}

export function sessionCallback<S extends { user: { id?: string } }>({ session, token }: { session: S; token: Token }): S {
  if (token.sub) {
    session.user.id = token.sub;
  }
  return session;
}
