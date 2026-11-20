"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, apiRequest, getCurrentUser, type User } from "@/lib/organizations";

export default function InvitationAcceptance({ token }: { token: string }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((currentUser) => {
        if (active) setUser(currentUser);
      })
      .catch((requestError: unknown) => {
        if (
          active &&
          !(requestError instanceof ApiError && requestError.status === 401)
        ) {
          setError(requestError instanceof Error ? requestError.message : "Could not load your account.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function accept() {
    setAccepting(true);
    setError("");
    try {
      await apiRequest(`/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      router.push("/");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The invitation could not be accepted.",
      );
    } finally {
      setAccepting(false);
    }
  }

  const loginUrl = `/login?next=${encodeURIComponent(`/team/accept?token=${token}`)}`;

  return (
    <main className="auth-screen">
      <section aria-labelledby="invite-accept-title" className="auth-card">
        <Link aria-label="EventFlow home" className="brand auth-brand" href="/">
          <span className="brand-mark"><span /></span>
          <span>eventflow</span>
        </Link>
        <p className="auth-eyebrow">TEAM INVITATION</p>
        <h1 id="invite-accept-title">Join the workspace</h1>
        {!token ? (
          <p className="auth-error" role="alert">This invitation link is missing its token.</p>
        ) : loading ? (
          <p className="auth-copy">Checking your sign-in status...</p>
        ) : user ? (
          <>
            <p className="auth-copy">
              Signed in as <strong>{user.email}</strong>. Accept this invitation to join your team.
            </p>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button
              className="button button-primary auth-submit"
              disabled={accepting}
              onClick={() => void accept()}
              type="button"
            >
              {accepting ? "Joining..." : "Accept invitation"}
            </button>
          </>
        ) : (
          <>
            <p className="auth-copy">Sign in with the email address that received this invitation.</p>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <Link className="button button-primary auth-submit" href={loginUrl}>
              Sign in to continue
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
