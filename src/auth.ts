import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verifyCredentials } from "@/server/auth/credentials";
import { jwtCallback, sessionCallback } from "@/server/auth/session-callbacks";

// DESIGN.md, "Authentication". Credentials sessions must be JWTs in Auth.js; the cookie carries only the
// user's id (`sub`), and everything a user may do is read from the database on each request.
export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: { signIn: "/signin" },
  logger: {
    // A failed sign-in is routine, not a server error: one line, without the email that was tried.
    // instanceof, not error.name: the production build minifies class names.
    error(error) {
      if (error instanceof CredentialsSignin) {
        console.warn("[auth] sign-in refused: wrong email or password");
        return;
      }
      console.error("[auth]", error);
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: (raw) => verifyCredentials(raw),
    }),
  ],
  callbacks: {
    jwt: ({ token, user }) => jwtCallback({ token, user }),
    session: ({ session, token }) => sessionCallback({ session, token }),
  },
});
