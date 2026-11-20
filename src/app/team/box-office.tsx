"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { apiRequest } from "@/lib/organizations";
import type { DashboardEvent, Organization } from "@/lib/organizations";
import { OperationsShell } from "./operations-shell";
import type {
  BoxOfficeSale,
  SeatingWorkspace,
} from "@/lib/event-operations";

export function BoxOfficeOperations({
  initialEventId,
  initialOrganization,
}: {
  initialEventId?: string;
  initialOrganization?: string;
}) {
  return (
    <OperationsShell
      description="Sell tickets quickly at the door with clear totals, cash change, and seat assignments."
      initialEventId={initialEventId}
      initialOrganization={initialOrganization}
      mode="box-office"
      title="Box office"
    >
      {({ event, organization }) =>
        event ? (
          <BoxOffice
            event={event}
            key={`${organization.id}-${event.id}`}
            organization={organization}
          />
        ) : null
      }
    </OperationsShell>
  );
}

export function BoxOffice({
  organization,
  event,
}: {
  organization: Organization;
  event: DashboardEvent;
}) {
  const [workspace, setWorkspace] = useState<SeatingWorkspace | null>(null);
  const [ticketId, setTicketId] = useState(0);
  const [tierId, setTierId] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | "comp">("cash");
  const [cardChargeConfirmed, setCardChargeConfirmed] = useState(false);
  const [cashReceived, setCashReceived] = useState("");
  const [seatIds, setSeatIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sale, setSale] = useState<BoxOfficeSale | null>(null);
  const submitLock = useRef(false);
  const saleAttempt = useRef<{ signature: string; key: string } | null>(null);
  const path =
    `/organizations/${encodeURIComponent(organization.slug)}/events/${event.id}`;
  const selectedTicket = workspace?.ticket_types.find((ticket) => ticket.id === ticketId);
  const priceTiers = selectedTicket?.price_tiers ?? [];
  const selectedTier = priceTiers.find((tier) => tier.id === tierId);
  const unitPrice = selectedTier?.price ?? selectedTicket?.price ?? "0";
  const totalCents = paymentMethod === "comp" ? 0 : toCents(unitPrice) * quantity;
  const receivedCents = toCents(cashReceived);
  const changeCents = Math.max(0, receivedCents - totalCents);
  const assignedZone = workspace?.zones.find(
    (zone) => zone.ticket_type_id === ticketId,
  );
  const selectableSeats = useMemo(
    () =>
      (workspace?.seats ?? []).filter(
        (seat) =>
          seat.ticket_type_id === ticketId &&
          seat.available &&
          !seat.blocked,
      ),
    [ticketId, workspace],
  );
  const needsSeats = Boolean(assignedZone);
  const canSubmit = Boolean(
    selectedTicket &&
      quantity >= 1 &&
      quantity <= 6 &&
      quantity <= selectedTicket.remaining &&
      (!priceTiers.length || Boolean(selectedTier && selectedTier.remaining >= quantity)) &&
      (!needsSeats || seatIds.length === quantity) &&
      (paymentMethod !== "cash" || receivedCents >= totalCents) &&
      (paymentMethod !== "card" || cardChargeConfirmed),
  );

  useEffect(() => {
    let active = true;
    apiRequest<SeatingWorkspace>(`${path}/seating`)
      .then((data) => {
        if (!active) return;
        const sellable = data.ticket_types.filter(
          (ticket) => !ticket.hidden && ticket.remaining > 0,
        );
        setWorkspace({ ...data, ticket_types: sellable });
        setTicketId(sellable[0]?.id ?? 0);
        setTierId(sellable[0]?.price_tiers.find((tier) => tier.remaining > 0)?.id ?? 0);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(messageFor(caught));
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [event.id, path]);

  function chooseTicket(nextId: number) {
    const ticket = workspace?.ticket_types.find((item) => item.id === nextId);
    setTicketId(nextId);
    setTierId(ticket?.price_tiers.find((tier) => tier.remaining > 0)?.id ?? 0);
    setSeatIds([]);
    setSale(null);
  }

  function toggleSeat(id: number) {
    setSale(null);
    setSeatIds((current) =>
      current.includes(id)
        ? current.filter((seatId) => seatId !== id)
        : current.length < quantity
          ? [...current, id]
          : current,
    );
  }

  async function submitSale() {
    const activeWorkspace = workspace;
    if (!activeWorkspace || !selectedTicket || !canSubmit || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setError("");
    setSale(null);
    const salePayload = {
      ticket_type_id: ticketId,
      price_tier_id: selectedTier?.id ?? null,
      quantity,
      customer_name: customerName.trim() || "Door sale",
      customer_email: customerEmail.trim() || null,
      payment_method: paymentMethod,
      cash_received: paymentMethod === "cash" ? centsToDecimal(receivedCents) : null,
      seat_ids: [...seatIds].sort((left, right) => left - right),
    };
    const signature = JSON.stringify(salePayload);
    if (saleAttempt.current?.signature !== signature) {
      saleAttempt.current = { signature, key: crypto.randomUUID() };
    }
    try {
      const result = await apiRequest<BoxOfficeSale>(`${path}/box-office/orders`, {
        method: "POST",
        body: JSON.stringify({
          ...salePayload,
          idempotency_key: saleAttempt.current.key,
        }),
      });
      saleAttempt.current = null;
      setSale(result);
      setSeatIds([]);
      setCustomerName("");
      setCustomerEmail("");
      setCashReceived("");
      const currentRemaining = selectedTicket.remaining - quantity;
      if (currentRemaining <= 0) {
        const nextTicket = activeWorkspace.ticket_types.find(
          (ticket) => ticket.id !== ticketId && ticket.remaining > 0,
        );
        setTicketId(nextTicket?.id ?? 0);
        setTierId(nextTicket?.price_tiers[0]?.id ?? 0);
      }
      setWorkspace((current) =>
        current
          ? {
              ...current,
              seats: current.seats.map((seat) =>
                seatIds.includes(seat.id)
                  ? { ...seat, available: false }
                  : seat,
              ),
              ticket_types: current.ticket_types
                .map((ticket) =>
                  ticket.id === ticketId
                    ? {
                        ...ticket,
                        remaining: Math.max(0, ticket.remaining - quantity),
                        price_tiers: ticket.price_tiers.map((tier) =>
                          tier.id === selectedTier?.id
                            ? { ...tier, remaining: Math.max(0, tier.remaining - quantity) }
                            : tier,
                        ),
                      }
                    : ticket,
                )
                .filter((ticket) => ticket.remaining > 0),
            }
          : current,
      );
    } catch (caught) {
      setError(messageFor(caught));
      try {
        const refreshed = await apiRequest<SeatingWorkspace>(`${path}/seating`);
        setWorkspace({
          ...refreshed,
          ticket_types: refreshed.ticket_types.filter(
            (ticket) => !ticket.hidden && ticket.remaining > 0,
          ),
        });
        const currentTicket = refreshed.ticket_types.find((ticket) => ticket.id === ticketId);
        setTierId(currentTicket?.price_tiers.find((tier) => tier.remaining > 0)?.id ?? 0);
        setSeatIds([]);
      } catch (refreshError) {
        setError(
          `${messageFor(caught)} Inventory could not be refreshed: ${messageFor(refreshError)}`,
        );
      }
    } finally {
      setSubmitting(false);
      submitLock.current = false;
    }
  }

  if (loading) {
    return <div className="operations-loading" aria-label="Loading box office"><span /><span /><span /></div>;
  }
  if (!workspace) {
    return <div className="operations-alert" role="alert">{error || "Ticket inventory could not be loaded."}</div>;
  }

  return (
    <section className="box-office">
      <div className="box-office-main">
        <div className="operations-panel-heading">
          <div><span>DOOR SALES</span><strong>Build an order</strong></div>
          <span className="seat-count-pill">{event.title}</span>
        </div>
        {workspace.ticket_types.length === 0 ? (
          <div className="operations-empty">
            <strong>No tickets available</strong>
            <span>Add active ticket types with capacity to this event.</span>
          </div>
        ) : (
          <>
            <div className="box-office-ticket-grid">
              {workspace.ticket_types.map((ticket) => (
                <button
                  aria-pressed={ticket.id === ticketId}
                  className={ticket.id === ticketId ? "box-ticket-card is-selected" : "box-ticket-card"}
                  key={ticket.id}
                  onClick={() => chooseTicket(ticket.id)}
                  type="button"
                >
                  <span>{ticket.name}</span>
                  <strong>{ticket.price_tiers.find((tier) => tier.remaining > 0)?.price ?? ticket.price} USD</strong>
                  <small>{ticket.remaining} remaining</small>
                </button>
              ))}
            </div>
            {selectedTicket && (
              <>
                <div className="box-office-fields">
                  {priceTiers.length > 0 && (
                    <label>
                      Price tier
                      <select
                        onChange={(change) => setTierId(Number(change.target.value))}
                        value={tierId}
                      >
                        {priceTiers.map((tier) => (
                          <option disabled={tier.remaining < quantity} key={tier.id} value={tier.id}>
                            {tier.name} · {tier.price} USD · {tier.remaining} left
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Quantity
                    <select
                      onChange={(change) => {
                        const nextQuantity = Number(change.target.value);
                        setQuantity(nextQuantity);
                        setSeatIds((current) => current.slice(0, nextQuantity));
                        if (selectedTier && selectedTier.remaining < nextQuantity) {
                          setTierId(
                            priceTiers.find((tier) => tier.remaining >= nextQuantity)?.id ?? 0,
                          );
                        }
                      }}
                      value={quantity}
                    >
                      {Array.from({ length: Math.min(6, selectedTicket.remaining) }, (_, index) => index + 1).map((count) => (
                        <option key={count} value={count}>{count}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {needsSeats && (
                  <div className="box-office-seat-section">
                    <div className="operations-panel-heading">
                      <div><span>RESERVED SEATING</span><strong>Select {quantity} seat{quantity === 1 ? "" : "s"}</strong></div>
                      <span>{seatIds.length} selected</span>
                    </div>
                    <div className="box-office-seat-grid">
                      {selectableSeats.map((seat) => (
                        <button
                          aria-pressed={seatIds.includes(seat.id)}
                          className={seatIds.includes(seat.id) ? "box-seat is-selected" : "box-seat"}
                          key={seat.id}
                          onClick={() => toggleSeat(seat.id)}
                          style={{ "--seat-color": seat.zone_color } as CSSProperties}
                          type="button"
                        >
                          {seat.label}
                        </button>
                      ))}
                      {selectableSeats.length === 0 && <span>No seats are currently available.</span>}
                    </div>
                  </div>
                )}
                <div className="box-office-fields">
                  <label>
                    Attendee name
                    <input
                      maxLength={180}
                      onChange={(change) => setCustomerName(change.target.value)}
                      placeholder="Door sale"
                      value={customerName}
                    />
                  </label>
                  <label>
                    Email (optional)
                    <input
                      maxLength={254}
                      onChange={(change) => setCustomerEmail(change.target.value)}
                      placeholder="attendee@example.com"
                      type="email"
                      value={customerEmail}
                    />
                  </label>
                </div>
                <fieldset className="box-office-payment">
                  <legend>Payment method</legend>
                  {(["cash", "card", "comp"] as const).map((method) => (
                    <label key={method}>
                      <input
                        checked={paymentMethod === method}
                        onChange={() => {
                          setPaymentMethod(method);
                          setCardChargeConfirmed(false);
                        }}
                        type="radio"
                        value={method}
                      />
                      <span>{method === "comp" ? "Complimentary" : method === "card" ? "Card terminal" : "Cash"}</span>
                    </label>
                  ))}
                </fieldset>
                {paymentMethod === "cash" && (
                  <div className="box-office-fields">
                    <label>
                      Cash received (USD)
                      <input
                        min="0"
                        onChange={(change) => setCashReceived(change.target.value)}
                        step="0.01"
                        type="number"
                        value={cashReceived}
                      />
                    </label>
                    <div className="box-change-due">
                      Change due <strong>{formatMoney(changeCents)}</strong>
                    </div>
                  </div>
                )}
                {paymentMethod === "card" && (
                  <label className="box-office-disclaimer box-card-confirmation">
                    <input
                      checked={cardChargeConfirmed}
                      onChange={(change) => setCardChargeConfirmed(change.target.checked)}
                      type="checkbox"
                    />
                    <span>I charged the customer on a separate card terminal. EventFlow does not collect or store card details.</span>
                  </label>
                )}
                {paymentMethod === "comp" && (
                  <p className="box-office-disclaimer">
                    Complimentary tickets are recorded with a zero total and no payment details.
                  </p>
                )}
                {error && <p className="operations-alert" role="alert">{error}</p>}
                <button
                  className="button button-primary box-office-submit"
                  disabled={!canSubmit || submitting}
                  onClick={submitSale}
                  type="button"
                >
                  {submitting ? "Completing sale…" : `Complete sale · ${formatMoney(totalCents)}`}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <aside className="box-office-summary">
        <div className="operations-panel-heading">
          <div><span>ORDER SUMMARY</span><strong>At the door</strong></div>
          <span className="box-summary-icon" aria-hidden="true">↗</span>
        </div>
        <div className="box-summary-line">
          <span>{quantity} × {selectedTicket?.name ?? "Select a ticket"}</span>
          <strong>{formatMoney(toCents(unitPrice) * quantity)}</strong>
        </div>
        {selectedTier && <div className="box-summary-muted">{selectedTier.name} price tier</div>}
        {seatIds.length > 0 && (
          <div className="box-summary-muted">Seats: {selectableSeats.filter((seat) => seatIds.includes(seat.id)).map((seat) => seat.label).join(", ")}</div>
        )}
        <div className="box-summary-total">
          <span>Total due</span><strong>{formatMoney(totalCents)}</strong>
        </div>
        <p>Card payments must be handled on a separate terminal.</p>
        {sale && (
          <div className="box-sale-success" role="status">
            <span>SALE COMPLETE</span>
            <strong>{sale.quantity} ticket{sale.quantity === 1 ? "" : "s"} issued</strong>
            <small>{sale.payment_method === "cash" ? `Change: ${formatMoney(toCents(sale.change_due))}` : sale.payment_method === "comp" ? "Complimentary" : "Card terminal"}</small>
            {sale.ticket_ids.map((id) => (
              <a href={`/api/v1/tickets/${id}/pdf`} key={id} rel="noreferrer" target="_blank">
                Download ticket PDF
              </a>
            ))}
          </div>
        )}
      </aside>
    </section>
  );
}

function toCents(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function centsToDecimal(value: number): string {
  return (value / 100).toFixed(2);
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The box-office sale could not be completed.";
}
