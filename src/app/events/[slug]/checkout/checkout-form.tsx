"use client";

import Link from "next/link";
import { ArrowLeft, LockKeyhole, Minus, Plus, Ticket } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";

import {
  apiTicketSchema,
  resolveInitialTicketId,
  type PublicEvent,
  type PublicTicket,
} from "@/lib/public-event";
import { getPublicSeatMap, type SeatMapData } from "@/lib/seating";
import { SeatPicker } from "./seat-picker";

const reservationSchema = z.object({
  id: z.string().uuid(),
});

const checkoutSessionSchema = z.object({
  checkout_url: z.string().url(),
});

const paymentConfigSchema = z.object({
  stripe_enabled: z.boolean(),
});

const promotionSchema = z.object({
  code: z.string(),
  discount_amount: z.string(),
  revealed_tickets: z.array(apiTicketSchema),
});

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
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
  return `Checkout failed (HTTP ${response.status}).`;
}

export function CheckoutForm({
  event,
  initialTicket,
  paymentCancelled,
}: {
  event: PublicEvent | null;
  initialTicket: string | null;
  paymentCancelled: boolean;
}) {
  const [quantity, setQuantity] = useState(1);
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState(() =>
    resolveInitialTicketId(event?.tickets ?? [], initialTicket),
  );
  const [revealedTickets, setRevealedTickets] = useState<PublicTicket[]>([]);
  const [promotionInput, setPromotionInput] = useState("");
  const [appliedPromotion, setAppliedPromotion] = useState<{
    code: string;
    discount: number;
  } | null>(null);
  const [promotionMessage, setPromotionMessage] = useState("");
  const [isValidatingPromotion, setIsValidatingPromotion] = useState(false);
  const [seatMap, setSeatMap] = useState<SeatMapData | null>(null);
  const [seatMapError, setSeatMapError] = useState("");
  const [seatMapLoading, setSeatMapLoading] = useState(
    Boolean(event?.hasSeating),
  );
  const [selectedSeatIds, setSelectedSeatIds] = useState<number[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null);

  const tickets = [
    ...(event?.tickets ?? []),
    ...revealedTickets.filter(
      (revealed) => !event?.tickets.some((ticket) => ticket.id === revealed.id),
    ),
  ];
  const initialTicketUnavailable = Boolean(
    event &&
      initialTicket &&
      !event.tickets.some((ticket) => ticket.id === initialTicket),
  );
  const selected = tickets.find((ticket) => ticket.id === selectedTicketId);
  const selectedTier = selected?.priceTiers.find(
    (tier) => tier.remaining >= quantity,
  );
  const maxQuantity = selected
    ? Math.min(
        6,
        selected.priceTiers.length
          ? Math.max(...selected.priceTiers.map((tier) => tier.remaining))
          : selected.remaining,
      )
    : 1;
  const unitPrice = selectedTier?.price ?? selected?.price ?? 0;
  const remaining =
    selected && selected.priceTiers.length > 0
      ? selectedTier?.remaining ?? 0
      : selected?.remaining ?? 0;
  const ticketRequiresSeats = Boolean(
    seatMap?.zones.some(
      (zone) => zone.ticket_type_id === Number(selected?.id),
    ),
  );
  const subtotal = selected ? unitPrice * quantity : 0;
  const fees = 0;
  const discount = Math.min(subtotal, appliedPromotion?.discount ?? 0);
  const total = subtotal - discount + fees;

  useEffect(() => {
    if (!event?.hasSeating) return;
    let active = true;
    void getPublicSeatMap(event.slug)
      .then((map) => {
        if (active) setSeatMap(map);
      })
      .catch((caught: unknown) => {
        if (active) {
          setSeatMapError(
            caught instanceof Error
              ? caught.message
              : "Could not load the seating map.",
          );
        }
      })
      .finally(() => {
        if (active) setSeatMapLoading(false);
      });
    return () => {
      active = false;
    };
  }, [event?.hasSeating, event?.slug]);

  function changeQuantity(nextQuantity: number) {
    setQuantity(nextQuantity);
    setSelectedSeatIds((current) => current.slice(0, nextQuantity));
    setAppliedPromotion(null);
    setPromotionMessage("");
  }

  function changeTicket(ticketId: string) {
    setSelectedTicketId(ticketId);
    setQuantity(1);
    setSelectedSeatIds([]);
    setAppliedPromotion(null);
    setPromotionMessage("");
  }

  async function applyPromotion() {
    if (!event || !selected || isValidatingPromotion) return;
    const code = promotionInput.trim();
    if (!code) {
      setPromotionMessage("Enter a promotion code first.");
      return;
    }

    setIsValidatingPromotion(true);
    setPromotionMessage("");
    try {
      const response = await fetch(
        `/api/v1/events/${encodeURIComponent(event.slug)}/promotions/validate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            ticket_type_id: Number(selected.id),
            ...(selectedTier ? { price_tier_id: Number(selectedTier.id) } : {}),
            quantity,
          }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));

      const result = promotionSchema.parse(await response.json());
      const revealed = result.revealed_tickets.map((ticket) => ({
        id: String(ticket.id),
        name: ticket.name,
        description: ticket.description,
        price: Number(ticket.price),
        remaining: ticket.remaining,
        priceTiers: ticket.price_tiers.map((tier) => ({
          id: String(tier.id),
          name: tier.name,
          price: Number(tier.price),
          remaining: tier.remaining,
        })),
      }));
      setRevealedTickets((current) => [
        ...current.filter(
          (existing) => !revealed.some((ticket) => ticket.id === existing.id),
        ),
        ...revealed,
      ]);
      setAppliedPromotion({
        code: result.code,
        discount: Number(result.discount_amount),
      });
      setPromotionInput(result.code);
      setPromotionMessage(`Code ${result.code} applied.`);
    } catch (caught) {
      setAppliedPromotion(null);
      setPromotionMessage(
        caught instanceof Error
          ? caught.message
          : "Unable to validate this code. Please try again.",
      );
    } finally {
      setIsValidatingPromotion(false);
    }
  }

  async function beginPayment(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (!event || !selected || isSubmitting) return;

    setError("");
    setIsSubmitting(true);
    const fingerprint = JSON.stringify({
      ticket: selected.id,
      tier: selectedTier?.id ?? null,
      quantity,
      seats: [...selectedSeatIds].sort((a, b) => a - b),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      promo: appliedPromotion?.code ?? null,
    });
    if (idempotency.current?.fingerprint !== fingerprint) {
      idempotency.current = { fingerprint, key: crypto.randomUUID() };
    }

    try {
      if (total > 0) {
        const configResponse = await fetch("/api/v1/payments/config", {
          cache: "no-store",
        });
        if (!configResponse.ok) {
          throw new Error(await responseError(configResponse));
        }
        const paymentConfig = paymentConfigSchema.parse(
          await configResponse.json(),
        );
        if (!paymentConfig.stripe_enabled) {
          throw new Error("Secure card payment is not available right now.");
        }
      }

      const reservationResponse = await fetch(
        `/api/v1/events/${encodeURIComponent(event.slug)}/reservations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ticket_type_id: Number(selected.id),
            ...(selectedTier ? { price_tier_id: Number(selectedTier.id) } : {}),
            quantity,
            customer_name: name,
            customer_email: email,
            idempotency_key: idempotency.current.key,
            ...(appliedPromotion ? { promo_code: appliedPromotion.code } : {}),
            seat_ids: selectedSeatIds,
          }),
        },
      );
      if (!reservationResponse.ok) {
        throw new Error(await responseError(reservationResponse));
      }
      const reservation = reservationSchema.parse(
        await reservationResponse.json(),
      );

      const checkoutResponse = await fetch(
        `/api/v1/orders/${reservation.id}/checkout-session`,
        { method: "POST" },
      );
      if (!checkoutResponse.ok) {
        throw new Error(await responseError(checkoutResponse));
      }
      const checkout = checkoutSessionSchema.parse(await checkoutResponse.json());
      const checkoutUrl = new URL(checkout.checkout_url, window.location.origin);
      if (
        checkoutUrl.origin !== window.location.origin &&
        checkoutUrl.hostname !== "checkout.stripe.com"
      ) {
        throw new Error("Stripe returned an unexpected checkout URL.");
      }
      window.location.assign(checkoutUrl);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to start checkout. Please try again.",
      );
      setIsSubmitting(false);
    }
  }

  if (!event || !selected) {
    return (
      <main className="checkout-shell">
        <nav className="checkout-nav">
          <Link className="public-brand" href="/">
            <span className="public-brand-mark" />
            <span>eventflow</span>
          </Link>
        </nav>
        <section className="checkout-confirmation">
          <span className="checkout-kicker">Event unavailable</span>
          <h1>We can’t find this event.</h1>
          <p>It may have ended or the link may be incorrect.</p>
          <Link className="checkout-primary unavailable-link" href="/">
            Browse events
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="checkout-shell">
      <nav className="checkout-nav">
        <Link className="checkout-back" href={`/events/${event.slug}`}>
          <ArrowLeft size={16} />
          <span>Back to event</span>
        </Link>
        <span className="checkout-nav-brand">
          <span className="public-brand-mark" />
          <strong>eventflow</strong>
        </span>
        <span className="checkout-secure">
          <LockKeyhole size={14} /> Secure checkout
        </span>
      </nav>

      <div className="checkout-layout">
        <section className="checkout-form">
          <div className="checkout-progress" aria-label={`Step ${step} of 2`}>
            <div className={step >= 1 ? "active" : ""}>
              <span>1</span>
              <strong>Tickets</strong>
            </div>
            <i />
            <div className={step >= 2 ? "active" : ""}>
              <span>2</span>
              <strong>Details</strong>
            </div>
          </div>

          {paymentCancelled && (
            <p className="checkout-message" role="status">
              Payment was cancelled. Your reservation will be held briefly.
            </p>
          )}
          {error && (
            <p className="checkout-message checkout-message--error" role="alert">
              {error}
            </p>
          )}
          {initialTicketUnavailable && (
            <p className="checkout-message" role="status">
              That ticket link is no longer available. Choose from the available tickets.
            </p>
          )}

          {step === 1 ? (
            <div className="checkout-step">
              <span className="checkout-kicker">Your order</span>
              <h1>Select tickets</h1>
              {tickets.length > 1 && (
                <label className="checkout-selector">
                  Ticket type
                  <select
                    onChange={(changeEvent) => changeTicket(changeEvent.target.value)}
                    value={selected.id}
                  >
                    {tickets.map((ticket) => (
                      <option key={ticket.id} value={ticket.id}>
                        {ticket.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selected.priceTiers.length > 0 && (
                <p className="checkout-tier-note" aria-live="polite">
                  {selectedTier
                    ? `${selectedTier.name} pricing · ${money.format(selectedTier.price)} per ticket`
                    : "No single price tier has enough tickets for this quantity."}
                </p>
              )}
              {event.hasSeating && seatMapLoading && (
                <p className="checkout-message" role="status">
                  Loading the seat map…
                </p>
              )}
              {seatMapError && (
                <p className="checkout-message checkout-message--error" role="alert">
                  {seatMapError}
                </p>
              )}
              {ticketRequiresSeats && seatMap && (
                <SeatPicker
                  onChange={setSelectedSeatIds}
                  quantity={quantity}
                  seatMap={seatMap}
                  selectedIds={selectedSeatIds}
                  ticketTypeId={Number(selected.id)}
                />
              )}
              <div className="checkout-ticket-row">
                <span className="checkout-ticket-icon">
                  <Ticket size={21} />
                </span>
                <div>
                  <strong>{selected.name}</strong>
                  <small>{money.format(unitPrice)} each</small>
                  <small>{remaining} remaining</small>
                </div>
                <div className="quantity-control" aria-label="Ticket quantity">
                  <button
                    aria-label="Decrease quantity"
                    disabled={quantity <= 1}
                    onClick={() => {
                      changeQuantity(Math.max(1, quantity - 1));
                    }}
                    type="button"
                  >
                    <Minus size={15} />
                  </button>
                  <span>{quantity}</span>
                  <button
                    aria-label="Increase quantity"
                    disabled={quantity >= maxQuantity}
                    onClick={() => {
                      changeQuantity(Math.min(maxQuantity, quantity + 1));
                    }}
                    type="button"
                  >
                    <Plus size={15} />
                  </button>
                </div>
              </div>
              <div className="promotion-entry">
                <label htmlFor="promotion-code">Promotion code</label>
                <div>
                  <input
                    autoCapitalize="characters"
                    id="promotion-code"
                    maxLength={64}
                    onChange={(changeEvent) => {
                      setPromotionInput(changeEvent.target.value);
                      setAppliedPromotion(null);
                      setPromotionMessage("");
                    }}
                    placeholder="Enter code"
                    value={promotionInput}
                  />
                  <button
                    disabled={isValidatingPromotion || !promotionInput.trim()}
                    onClick={applyPromotion}
                    type="button"
                  >
                    {isValidatingPromotion ? "Checking…" : "Apply"}
                  </button>
                </div>
                {promotionMessage && (
                  <p
                    className={
                      appliedPromotion
                        ? "promotion-feedback promotion-feedback--success"
                        : "promotion-feedback"
                    }
                    role="status"
                  >
                    {promotionMessage}
                  </p>
                )}
              </div>
              <button
                className="checkout-primary"
                disabled={
                  remaining < quantity ||
                  (event.hasSeating && !seatMap) ||
                  (ticketRequiresSeats && selectedSeatIds.length !== quantity)
                }
                onClick={() => setStep(2)}
                type="button"
              >
                {ticketRequiresSeats && selectedSeatIds.length !== quantity
                  ? `Select ${quantity} seat${quantity === 1 ? "" : "s"}`
                  : remaining < 1
                  ? selected.priceTiers.length > 0 && selected.remaining > 0
                    ? "Adjust quantity for available pricing"
                    : "Tickets unavailable"
                  : "Continue to details"}
              </button>
            </div>
          ) : (
            <form className="checkout-step" onSubmit={beginPayment}>
              <span className="checkout-kicker">Contact details</span>
              <h1>Who’s going?</h1>
              <div className="checkout-fields">
                <label>
                  Full name
                  <input
                    autoFocus
                    autoComplete="name"
                    maxLength={180}
                    onChange={(inputEvent) => setName(inputEvent.target.value)}
                    placeholder="Alex Morgan"
                    required
                    value={name}
                  />
                </label>
                <label>
                  Email address
                  <input
                    autoComplete="email"
                    onChange={(inputEvent) => setEmail(inputEvent.target.value)}
                    placeholder="alex@example.com"
                    required
                    type="email"
                    value={email}
                  />
                </label>
              </div>
              <div className="payment-placeholder">
                {total > 0 ? (
                  <LockKeyhole size={16} />
                ) : (
                  <Ticket size={16} />
                )}
                <div>
                  <strong>
                    {total > 0 ? "Secure payment by Stripe" : "Free tickets"}
                  </strong>
                  <span>
                    {total > 0
                      ? "You’ll complete payment on Stripe’s hosted checkout."
                      : "Confirm your tickets instantly. No payment details required."}
                  </span>
                </div>
              </div>
              <div className="checkout-actions">
                <button
                  className="checkout-secondary"
                  onClick={() => setStep(1)}
                  type="button"
                >
                  Back
                </button>
                <button
                  className="checkout-primary"
                  disabled={
                    isSubmitting ||
                    !name.trim() ||
                    !email.includes("@") ||
                    remaining < quantity
                  }
                  type="submit"
                >
                  {isSubmitting
                    ? "Connecting to Stripe…"
                    : total > 0
                      ? `Pay ${money.format(total)}`
                      : "Confirm free tickets"}
                </button>
              </div>
            </form>
          )}
        </section>

        <aside className="checkout-summary" aria-label="Order summary">
          <span className="summary-art">{event.title.slice(0, 2).toUpperCase()}</span>
          <div className="summary-event">
            <span>{event.date}</span>
            <strong>{event.title}</strong>
            <small>
              {event.venue} · {event.time}
            </small>
          </div>
          <div className="summary-lines">
            <div>
              <span>
                {quantity} × {selected.name}
              </span>
              <strong>{money.format(subtotal)}</strong>
            </div>
            {discount > 0 && (
              <div>
                <span>Promotion{appliedPromotion ? ` · ${appliedPromotion.code}` : ""}</span>
                <strong>−{money.format(discount)}</strong>
              </div>
            )}
            <div>
              <span>Fees</span>
              <strong>{money.format(fees)}</strong>
            </div>
          </div>
          <div className="summary-total">
            <span>Total</span>
            <strong>{money.format(total)}</strong>
          </div>
        </aside>
      </div>
    </main>
  );
}
