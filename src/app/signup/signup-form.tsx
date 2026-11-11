"use client";

import { useActionState } from "react";
import { signUpAction, type FormState } from "../actions";

function Field(props: {
  name: string;
  label: string;
  type?: string;
  autoComplete: string;
  state: FormState;
}) {
  const errors = props.state.fieldErrors?.[props.name];
  return (
    <p>
      <label htmlFor={props.name}>{props.label}</label>
      <input
        id={props.name}
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        defaultValue={props.state.values?.[props.name]}
        aria-invalid={errors ? true : undefined}
        aria-describedby={errors ? `${props.name}-error` : undefined}
        required
      />
      {errors ? (
        <span id={`${props.name}-error`} className="error">
          {errors.join(" ")}
        </span>
      ) : null}
    </p>
  );
}

export function SignUpForm() {
  const [state, action, pending] = useActionState(signUpAction, {});
  return (
    <form action={action} className="stack" noValidate>
      <Field name="name" label="Your name" autoComplete="name" state={state} />
      <Field name="email" label="Email" type="email" autoComplete="email" state={state} />
      <Field name="password" label="Password (at least 10 characters)" type="password" autoComplete="new-password" state={state} />
      <Field name="organizationName" label="Organization name" autoComplete="organization" state={state} />
      <button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
