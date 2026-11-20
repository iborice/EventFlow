"use client";

import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Ticket,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { apiRequest } from "@/lib/organizations";
import type { DashboardEvent } from "@/lib/organizations";
import {
  toEventCreatePayload,
  validateEventStep,
  type EventDraft,
} from "@/lib/event-creation";

const initialDraft: EventDraft = {
  title: "",
  description: "",
  starts_at: "",
  venue: "",
  ticket_name: "General admission",
  ticket_description: "",
  price: "25.00",
  capacity: "100",
  status: "draft",
  use_price_tiers: false,
  price_tiers: [{ name: "Early bird", price: "20.00", capacity: "100" }],
};

const stepTitles = ["Event details", "Date & place", "Tickets"];

export function EventCreateDialog({
  organizationSlug,
  onClose,
  onCreated,
}: {
  organizationSlug: string;
  onClose: () => void;
  onCreated: (event: DashboardEvent) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const submittingRef = useRef(isSubmitting);
  const submissionLock = useRef(false);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submittingRef.current) {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);

  useEffect(() => {
    if (errors.form) {
      formErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [errors.form]);

  function updateField<K extends keyof EventDraft>(
    field: K,
    value: EventDraft[K],
  ) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      delete next.form;
      return next;
    });
  }

  function moveToNextStep() {
    const nextErrors = validateEventStep(draft, step);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) setStep((current) => current + 1);
  }

  function updateTier(
    index: number,
    field: keyof EventDraft["price_tiers"][number],
    value: string,
  ) {
    setDraft((current) => ({
      ...current,
      price_tiers: current.price_tiers.map((tier, tierIndex) =>
        tierIndex === index ? { ...tier, [field]: value } : tier,
      ),
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next.price_tiers;
      delete next.form;
      return next;
    });
  }

  function addTier() {
    if (draft.price_tiers.length >= 20) {
      setErrors((current) => ({
        ...current,
        price_tiers: "A ticket can have up to 20 price tiers.",
      }));
      return;
    }
    setDraft((current) => ({
      ...current,
      price_tiers: [
        ...current.price_tiers,
        {
          name: `Tier ${current.price_tiers.length + 1}`,
          price: current.price,
          capacity: "",
        },
      ],
    }));
    setErrors((current) => {
      const next = { ...current };
      delete next.price_tiers;
      return next;
    });
  }

  async function submitEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < stepTitles.length - 1) {
      moveToNextStep();
      return;
    }

    const result = toEventCreatePayload(draft);
    if (!result.success) {
      setErrors(result.errors);
      return;
    }
    if (submissionLock.current) return;

    submissionLock.current = true;
    setIsSubmitting(true);
    submittingRef.current = true;
    setErrors({});
    try {
      const created = await apiRequest<DashboardEvent>(
        `/organizations/${encodeURIComponent(organizationSlug)}/events`,
        {
          method: "POST",
          body: JSON.stringify(result.data),
        },
      );
      onCreated(created);
      onClose();
    } catch (caught) {
      setErrors({
        form:
          caught instanceof Error
            ? caught.message
            : "The event could not be created. Please try again.",
      });
    } finally {
      submittingRef.current = false;
      submissionLock.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="dialog-backdrop event-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) onClose();
      }}
    >
      <div
        aria-describedby="event-create-description"
        aria-labelledby="event-create-title"
        aria-modal="true"
        className="event-dialog event-create-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="dialog-top">
          <span className="dialog-icon"><CalendarDays size={19} /></span>
          <button
            aria-label="Close event creation"
            className="icon-button dialog-close"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        <div className="event-create-heading">
          <div>
            <p className="auth-eyebrow">NEW EVENT</p>
            <h2 id="event-create-title">Bring your event to life</h2>
            <p className="dialog-copy" id="event-create-description">
              Add the essentials now. You can refine the event and its tickets later.
            </p>
          </div>
          <span className="event-create-step-count">0{step + 1} / 03</span>
        </div>

        <ol aria-label="Event creation progress" className="event-create-progress">
          {stepTitles.map((title, index) => (
            <li
              aria-current={index === step ? "step" : undefined}
              className={index <= step ? "is-current" : ""}
              key={title}
            >
              <span>{index < step ? "✓" : `0${index + 1}`}</span>
              <small>{title}</small>
            </li>
          ))}
        </ol>

        <form noValidate onSubmit={submitEvent}>
          {step === 0 && (
            <div className="event-create-fields">
              <label>
                Event name
                <input
                  aria-describedby={errors.title ? "event-title-error" : undefined}
                  aria-invalid={Boolean(errors.title)}
                  autoComplete="off"
                  data-autofocus
                  maxLength={180}
                  onChange={(change) => updateField("title", change.target.value)}
                  placeholder="e.g. Summer Sound Sessions"
                  value={draft.title}
                />
                <FieldError id="event-title-error" message={errors.title} />
              </label>
              <label>
                Description <span className="event-create-optional">Optional</span>
                <textarea
                  aria-describedby={errors.description ? "event-description-error" : undefined}
                  aria-invalid={Boolean(errors.description)}
                  maxLength={5000}
                  onChange={(change) => updateField("description", change.target.value)}
                  placeholder="What should guests know about this event?"
                  rows={4}
                  value={draft.description}
                />
                <FieldError id="event-description-error" message={errors.description} />
              </label>
            </div>
          )}

          {step === 1 && (
            <div className="event-create-fields">
              <label>
                Date and start time
                <span className="event-create-input-icon">
                  <CalendarDays aria-hidden="true" size={16} />
                  <input
                    aria-describedby={errors.starts_at ? "event-start-error" : undefined}
                    aria-invalid={Boolean(errors.starts_at)}
                    data-autofocus
                    onChange={(change) => updateField("starts_at", change.target.value)}
                    type="datetime-local"
                    value={draft.starts_at}
                  />
                </span>
                <small className="event-create-help">Shown in your local time zone.</small>
                <FieldError id="event-start-error" message={errors.starts_at} />
              </label>
              <label>
                Venue
                <span className="event-create-input-icon">
                  <MapPin aria-hidden="true" size={16} />
                  <input
                    aria-describedby={errors.venue ? "event-venue-error" : undefined}
                    aria-invalid={Boolean(errors.venue)}
                    autoComplete="street-address"
                    maxLength={240}
                    onChange={(change) => updateField("venue", change.target.value)}
                    placeholder="Venue name or address"
                    value={draft.venue}
                  />
                </span>
                <FieldError id="event-venue-error" message={errors.venue} />
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="event-create-fields">
              <div className="event-create-ticket-intro">
                <span className="event-create-ticket-icon"><Ticket size={17} /></span>
                <span><strong>First ticket type</strong><small>Start simple; add more from your event settings.</small></span>
              </div>
              <div className="event-create-field-grid">
                <label>
                  Ticket name
                  <input
                    aria-describedby={errors.ticket_name ? "ticket-name-error" : undefined}
                    aria-invalid={Boolean(errors.ticket_name)}
                    data-autofocus
                    maxLength={120}
                    onChange={(change) => updateField("ticket_name", change.target.value)}
                    value={draft.ticket_name}
                  />
                  <FieldError id="ticket-name-error" message={errors.ticket_name} />
                </label>
                <label>
                  Ticket price (USD)
                  <input
                    aria-describedby={errors.price ? "ticket-price-error" : undefined}
                    aria-invalid={Boolean(errors.price)}
                    inputMode="decimal"
                    onChange={(change) => updateField("price", change.target.value)}
                    placeholder="25.00"
                    value={draft.price}
                  />
                  <FieldError id="ticket-price-error" message={errors.price} />
                </label>
              </div>
              <div className="event-create-field-grid">
                <label>
                  Ticket capacity
                  <input
                    aria-describedby={errors.capacity ? "ticket-capacity-error" : undefined}
                    aria-invalid={Boolean(errors.capacity)}
                    inputMode="numeric"
                    onChange={(change) => updateField("capacity", change.target.value)}
                    value={draft.capacity}
                  />
                  <FieldError id="ticket-capacity-error" message={errors.capacity} />
                </label>
                <label>
                  Event visibility
                  <select
                    onChange={(change) => {
                      const status = change.target.value;
                      if (status === "draft" || status === "published") {
                        updateField("status", status);
                      }
                    }}
                    value={draft.status}
                  >
                    <option value="draft">Save as draft</option>
                    <option value="published">Publish now</option>
                  </select>
                </label>
              </div>
              <label>
                Ticket description <span className="event-create-optional">Optional</span>
                <textarea
                  maxLength={5000}
                  onChange={(change) => updateField("ticket_description", change.target.value)}
                  placeholder="Included with this ticket"
                  rows={2}
                  value={draft.ticket_description}
                />
              </label>
              <label className="event-tier-toggle">
                <input
                  checked={draft.use_price_tiers}
                  onChange={(change) => {
                    updateField("use_price_tiers", change.target.checked);
                    setErrors((current) => {
                      const next = { ...current };
                      delete next.price_tiers;
                      return next;
                    });
                  }}
                  type="checkbox"
                />
                <span><strong>Use sequential price tiers</strong><small>Offer different prices as ticket inventory sells.</small></span>
              </label>
              {draft.use_price_tiers && (
                <div className="event-tier-list">
                  {draft.price_tiers.map((tier, index) => (
                    <div className="event-tier-row" key={`tier-${index}`}>
                      <label>
                        <span className="sr-only">Tier {index + 1} name</span>
                        <input
                          aria-label={`Tier ${index + 1} name`}
                          onChange={(change) => updateTier(index, "name", change.target.value)}
                          placeholder="Tier name"
                          value={tier.name}
                        />
                      </label>
                      <label>
                        <span className="sr-only">Tier {index + 1} price</span>
                        <input
                          aria-label={`Tier ${index + 1} price`}
                          inputMode="decimal"
                          onChange={(change) => updateTier(index, "price", change.target.value)}
                          placeholder="Price"
                          value={tier.price}
                        />
                      </label>
                      <label>
                        <span className="sr-only">Tier {index + 1} capacity</span>
                        <input
                          aria-label={`Tier ${index + 1} capacity`}
                          inputMode="numeric"
                          onChange={(change) => updateTier(index, "capacity", change.target.value)}
                          placeholder="Capacity"
                          value={tier.capacity}
                        />
                      </label>
                      <button
                        aria-label={`Remove tier ${index + 1}`}
                        className="icon-button event-tier-remove"
                        disabled={draft.price_tiers.length === 1}
                        onClick={() => {
                          setDraft((current) => ({
                            ...current,
                            price_tiers: current.price_tiers.filter(
                              (_, tierIndex) => tierIndex !== index,
                            ),
                          }));
                          setErrors((current) => {
                            const next = { ...current };
                            delete next.price_tiers;
                            return next;
                          });
                        }}
                        type="button"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {errors.price_tiers && (
                    <FieldError id="price-tiers-error" message={errors.price_tiers} />
                  )}
                  <button className="event-tier-add" onClick={addTier} type="button">
                    <Plus size={14} /> Add price tier
                  </button>
                </div>
              )}
            </div>
          )}

          {errors.form && (
            <p
              aria-live="assertive"
              className="form-error event-create-error"
              ref={formErrorRef}
              role="alert"
            >
              {errors.form}
            </p>
          )}

          <div className="dialog-actions event-create-actions">
            {step > 0 ? (
              <button
                className="button button-quiet"
                disabled={isSubmitting}
                onClick={() => {
                  setStep((current) => current - 1);
                  setErrors({});
                }}
                type="button"
              >
                <ChevronLeft size={15} /> Back
              </button>
            ) : (
              <button
                className="button button-quiet"
                disabled={isSubmitting}
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
            )}
            <button
              className="button button-primary"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting
                ? "Creating event…"
                : step === stepTitles.length - 1
                  ? draft.status === "published"
                    ? "Publish event"
                    : "Save as draft"
                  : <>Continue <ChevronRight size={15} /></>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <small className="event-field-error" id={id}>{message}</small> : null;
}
