import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SignUpForm } from "./signup-form";

export const metadata = { title: "Create an organization · Tally" };

export default async function SignUpPage() {
  if ((await auth())?.user?.id) {
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
