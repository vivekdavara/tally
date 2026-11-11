import { signOutAction } from "./actions";

export function SignOutButton() {
  return (
    <form action={signOutAction}>
      <button type="submit">Sign out</button>
    </form>
  );
}
