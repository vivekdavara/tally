import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/dal";
import { SignUpForm } from "./signup-form";

export const metadata = { title: "Create an organization · Tally" };

export default async function SignUpPage() {
  // The user, not just a session: a session can outlive its user (see getCurrentUser).
  if (await getCurrentUser()) {
    redirect("/o");
  }
  return (
    <section className="stack">
      <h1>Create an organization</h1>
      <SignUpForm />
      <p className="muted">
        Already have an account? <Link href="/signin">Sign in</Link>
      </p>
    </section>
  );
}
