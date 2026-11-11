"use client";

import { useActionState } from "react";
import { signInAction } from "../actions";

export function SignInForm() {
  const [state, action, pending] = useActionState(signInAction, {});
  return (
    <form action={action} className="stack">
      <p>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" defaultValue={state.values?.email} required />
      </p>
      <p>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </p>
      {state.error ? (
        <p role="alert" className="error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
