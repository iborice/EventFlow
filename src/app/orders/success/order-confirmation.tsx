"use client";

import Link from "next/link";
import { Check, CircleHelp, Ticket } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

const orderSchema = z.object({
  id: z.string().uuid(),
  event_slug: z.string(),
  event_title: z.string(),
  status: z.string(),
  currency: z.string(),
  total: z.string(),
  tickets: z.array(
    z.object({
      id: z.string().uuid(),
      ticket_name: z.string(),
      pdf_url: z.string(),
      seat_label: z.string().nullable(),
      checked_in_at: z.string().nullable(),
    }),
  ),
});

type Order = z.infer<typeof orderSchema>;

export function OrderConfirmation({ orderId }: { orderId: string | null }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!orderId) {
      return;
    }

    const currentOrderId = orderId;
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function refreshOrder() {
      attempts += 1;
      try {
        const response = await fetch(
          `/api/v1/orders/${encodeURIComponent(currentOrderId)}`,
          { cache: "no-store" },
        );
        if (!response.ok) {
          throw new Error(`Could not load this order (HTTP ${response.status}).`);
        }
        const result = orderSchema.parse(await response.json());
        if (!active) return;
        setOrder(result);
        setError("");
        if (result.status === "pending" && attempts < 30) {
          timer = setTimeout(refreshOrder, 2000);
        }
      } catch (caught) {
        if (!active) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not load this order.",
        );
      }
    }

    void refreshOrder();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [orderId]);

  const confirmed = order?.status === "confirmed";
  const refundPending = order?.status === "refund_pending";
  const requestError = orderId ? error : "Order reference is missing.";

  return (
    <main className="checkout-shell">
      <nav className="checkout-nav">
        <Link className="public-brand" href="/">
          <span className="public-brand-mark" />
          <span>eventflow</span>
        </Link>
      </nav>
      <section className="checkout-confirmation" aria-live="polite">
        <span className="confirmation-check">
          {confirmed ? <Check size={28} /> : <CircleHelp size={28} />}
        </span>
        <span className="checkout-kicker">
          {confirmed
            ? order?.total === "0.00"
              ? "Registration confirmed"
              : "Payment confirmed"
            : "Order status"}
        </span>
        <h1>
          {confirmed
            ? "You’re going."
            : refundPending
              ? "Your refund is being processed."
              : order?.status === "expired" || order?.status === "cancelled"
                ? "This reservation is no longer active."
                : "Confirming your payment…"}
        </h1>
        <p>
          {confirmed
            ? `Your tickets for ${order.event_title} are ready to download.`
            : refundPending
              ? "We couldn’t secure the tickets after payment. Stripe is processing a refund."
              : requestError ||
                "This page will update automatically when Stripe confirms your payment."}
        </p>
        {order?.tickets.map((ticket) => (
          <div className="confirmation-ticket" key={ticket.id}>
            <span className="confirmation-art">
              <Ticket size={20} />
            </span>
            <div>
              <strong>{ticket.ticket_name}</strong>
              {ticket.seat_label && <small>Seat {ticket.seat_label}</small>}
              <small>Order {order.id.slice(0, 8).toUpperCase()}</small>
            </div>
            <a className="checkout-primary" href={ticket.pdf_url}>
              Download PDF
            </a>
          </div>
        ))}
        {order?.event_slug && (
          <Link className="confirmation-link" href={`/events/${order.event_slug}`}>
            Back to event
          </Link>
        )}
        {!order && (
          <Link className="confirmation-link" href="/">
            Browse events
          </Link>
        )}
      </section>
    </main>
  );
}
