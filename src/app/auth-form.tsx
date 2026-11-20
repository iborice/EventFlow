"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { z } from "zod";
import { apiRequest } from "@/lib/organizations";

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

const registrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(1, "Enter your name.").max(150),
  organization_name: z
    .string()
    .trim()
    .min(1, "Enter your organization name.")
    .max(180),
});

interface AuthFormProps {
  mode: "login" | "register";
}

export default function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isRegistration = mode === "register";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formData = new FormData(event.currentTarget);
    const rawInput = Object.fromEntries(formData.entries());
    const parsed = (isRegistration
      ? registrationSchema
      : credentialsSchema
    ).safeParse(rawInput);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your details and try again.");
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest(
        isRegistration ? "/auth/register" : "/auth/login",
        {
          method: "POST",
          body: JSON.stringify(parsed.data),
        },
      );
      const requestedPath = new URLSearchParams(window.location.search).get("next");
      const nextPath =
        requestedPath?.startsWith("/") && !requestedPath.startsWith("//")
          ? requestedPath
          : "/";
      router.push(nextPath);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "We could not sign you in. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section aria-labelledby="auth-title" className="auth-card">
        <Link aria-label="EventFlow home" className="brand auth-brand" href="/">
          <span className="brand-mark"><span /></span>
          <span>eventflow</span>
        </Link>
        <p className="auth-eyebrow">{isRegistration ? "GET STARTED" : "WELCOME BACK"}</p>
        <h1 id="auth-title">
          {isRegistration ? "Create your workspace" : "Sign in to EventFlow"}
        </h1>
        <p className="auth-copy">
          {isRegistration
            ? "Bring your team together and start managing your events."
            : "Your events and team workspace are waiting for you."}
        </p>

        <form className="auth-form" onSubmit={submit} noValidate>
          {isRegistration && (
            <>
              <label>
                Your name
                <input autoComplete="name" name="name" required />
              </label>
              <label>
                Organization name
                <input autoComplete="organization" name="organization_name" required />
              </label>
            </>
          )}
          <label>
            Email address
            <input autoComplete="email" name="email" required type="email" />
          </label>
          <label>
            Password
            <input
              autoComplete={isRegistration ? "new-password" : "current-password"}
              name="password"
              required
              type="password"
            />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" disabled={submitting} type="submit">
            {submitting
              ? "Please wait..."
              : isRegistration
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          {isRegistration ? "Already have an account?" : "New to EventFlow?"}{" "}
          <Link href={isRegistration ? "/login" : "/register"}>
            {isRegistration ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
}
