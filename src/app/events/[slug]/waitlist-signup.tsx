"use client";

import { useState, type FormEvent } from "react";
import { z } from "zod";

const waitlistResponseSchema = z.object({
  token: z.string().uuid(),
  status: z.string(),
  quantity: z.number().int(),
  order_id: z.string().uuid().nullable(),
  offer_expires_at: z.string().nullable(),
  total: z.string().nullable(),
});

const checkoutResponseSchema = z.object({
  checkout_url: z.string().url(),
});

async function responseError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  if (
    typeof body === "object" &&
    body !== null &&
    "detail" in body &&
    typeof body.detail === "string"
  ) {
    return body.detail;
  }
  return `Waitlist request failed (HTTP ${response.status}).`;
}

export function WaitlistSignup({
  slug,
  ticketId,
  ticketName,
}: {
  slug: string;
  ticketId: string;
  ticketName: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState("");
  const [offer, setOffer] = useState<z.infer<typeof waitlistResponseSchema> | null>(
    null,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isWorking) return;
    setIsWorking(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/events/${encodeURIComponent(slug)}/waitlist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket_type_id: Number(ticketId),
            quantity: 1,
            customer_name: name,
            customer_email: email,
          }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      const entry = waitlistResponseSchema.parse(await response.json());
      setToken(entry.token);
      setStatus(entry.status);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to join the waitlist. Please try again.",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function refreshOffer() {
    if (!token || isWorking) return;
    setIsWorking(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/waitlist/${token}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await responseError(response));
      const entry = waitlistResponseSchema.parse(await response.json());
      setStatus(entry.status);
      setOffer(entry);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to check your waitlist status.",
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function claimOffer() {
    if (!token || isWorking) return;
    setIsWorking(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/waitlist/${token}/checkout-session`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await responseError(response));
      const result = checkoutResponseSchema.parse(await response.json());
      const checkoutUrl = new URL(result.checkout_url, window.location.origin);
      if (
        checkoutUrl.origin !== window.location.origin &&
        checkoutUrl.hostname !== "checkout.stripe.com"
      ) {
        throw new Error("The checkout service returned an unexpected URL.");
      }
      window.location.assign(checkoutUrl);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to claim this offer. Please try again.",
      );
      setIsWorking(false);
    }
  }

  return (
    <div className="waitlist-signup">
      {!isOpen && !token && (
        <button
          className="checkout-secondary"
          onClick={() => setIsOpen(true)}
          type="button"
        >
          Join the waitlist
        </button>
      )}
      {isOpen && !token && (
        <form className="waitlist-form" onSubmit={submit}>
          <strong>Get an offer for {ticketName}</strong>
          <label>
            Full name
            <input
              autoComplete="name"
              maxLength={180}
              onChange={(changeEvent) => setName(changeEvent.target.value)}
              required
              value={name}
            />
          </label>
          <label>
            Email address
            <input
              autoComplete="email"
              onChange={(changeEvent) => setEmail(changeEvent.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <button className="checkout-primary" disabled={isWorking} type="submit">
            {isWorking ? "Joining…" : "Join waitlist"}
          </button>
        </form>
      )}
      {token && (
        <div className="waitlist-status" role="status">
          <strong>
            {status === "offered"
              ? "A ticket is available for you."
              : status === "converted"
                ? "Your waitlist offer was claimed."
                : status === "expired"
                  ? "This waitlist offer expired."
                  : "You’re on the waitlist."}
          </strong>
          {status === "waiting" && (
            <button
              className="checkout-secondary"
              disabled={isWorking}
              onClick={refreshOffer}
              type="button"
            >
              {isWorking ? "Checking…" : "Check for an offer"}
            </button>
          )}
          {status === "offered" && offer?.offer_expires_at && (
            <>
              <span>
                Offer expires {new Date(offer.offer_expires_at).toLocaleString()}
                {offer.total !== null &&
                  ` · ${new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                  }).format(Number(offer.total))}`}
              </span>
              <button
                className="checkout-primary"
                disabled={isWorking}
                onClick={claimOffer}
                type="button"
              >
                {isWorking ? "Opening checkout…" : "Claim tickets"}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="checkout-message checkout-message--error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
