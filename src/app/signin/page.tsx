import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SignInForm } from "./signin-form";

export const metadata = { title: "Sign in · Tally" };

export default async function SignInPage() {
  if ((await auth())?.user?.id) {
    redirect("/o");
  }
  return (
    <section className="stack">
      <h1>Sign in</h1>
      <SignInForm />
      <p className="muted">
        New to Tally? <Link href="/signup">Create an organization</Link>
      </p>
    </section>
  );
}
