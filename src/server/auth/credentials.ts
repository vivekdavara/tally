import type { Db } from "../db/client";
import { db } from "../db/client";
import { dummyHash, verifyPassword } from "./password";
import { signInInput } from "./schemas";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Auth.js's `authorize` for the Credentials provider: the user if the email and password match, else null.
 * `raw` is whatever the sign-in request carried, so it is validated here. An unknown email costs one scrypt
 * against a dummy hash, like a wrong password, and both return the same null.
 */
export async function verifyCredentials(raw: unknown, client: Db = db()): Promise<AuthenticatedUser | null> {
  const parsed = signInInput.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { email, password } = parsed.data;
  const user = await client.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true },
  });
  if (!user) {
    await verifyPassword(password, await dummyHash());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return null;
  }
  return { id: user.id, email: user.email, name: user.name };
}
