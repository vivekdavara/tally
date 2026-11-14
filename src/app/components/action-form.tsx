"use client";

import { useActionState } from "react";
import type { FormState } from "../actions";

export interface FieldSpec {
  name: string;
  label: string;
  type?: "text" | "email" | "number";
  multiline?: boolean;
  options?: { value: string; label: string }[];
  defaultValue?: string;
  inputMode?: "decimal" | "numeric";
  placeholder?: string;
  required?: boolean;
}

/**
 * A form posting to a Server Action through useActionState. Fields are described as data so the server page
 * can declare them while this component echoes back what was typed (and shows each field's errors) when the
 * action refuses the input.
 */
export function ActionForm(props: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  fields?: FieldSpec[];
  submit: string;
  pending: string;
  className?: string;
  danger?: boolean;
  testId?: string;
}) {
  const [state, action, pending] = useActionState(props.action, {});
  return (
    <form action={action} className={props.className ?? "stack"} noValidate data-testid={props.testId}>
      {props.fields?.map((field) => {
        const errors = state.fieldErrors?.[field.name];
        const value = state.values?.[field.name] ?? field.defaultValue;
        const common = {
          id: `${props.testId ?? "f"}-${field.name}`,
          name: field.name,
          defaultValue: value,
          "aria-invalid": errors ? true : undefined,
          "aria-describedby": errors ? `${props.testId ?? "f"}-${field.name}-error` : undefined,
          required: field.required,
        };
        return (
          <p key={field.name}>
            <label htmlFor={common.id}>{field.label}</label>
            {field.options ? (
              <select {...common}>
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : field.multiline ? (
              <textarea {...common} rows={3} />
            ) : (
              <input {...common} type={field.type ?? "text"} inputMode={field.inputMode} placeholder={field.placeholder} />
            )}
            {errors ? (
              <span id={`${common.id}-error`} className="error">
                {errors.join(" ")}
              </span>
            ) : null}
          </p>
        );
      })}
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.notice ? (
        <p className="notice" role="status">
          <output data-testid={`${props.testId ?? "f"}-notice`}>{state.notice}</output>
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={props.danger ? "danger" : undefined}>
        {pending ? props.pending : props.submit}
      </button>
    </form>
  );
}
