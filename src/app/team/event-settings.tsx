"use client";

import {
  ArrowLeft,
  CalendarDays,
  Check,
  CircleAlert,
  MapPin,
  Save,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  getCurrentUser,
  getEventConfiguration,
  getOrganizations,
  updateEventConfiguration,
  type EventConfiguration,
  type Organization,
} from "@/lib/organizations";

function toLocalDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function EventSettings({
  eventId,
  initialOrganization,
}: {
  eventId: number;
  initialOrganization?: string;
}) {
  const router = useRouter();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [configuration, setConfiguration] = useState<EventConfiguration | null>(
    null,
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [venue, setVenue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;

    async function loadConfiguration() {
      try {
        await getCurrentUser();
        const organizations = await getOrganizations();
        const selectedOrganization =
          organizations.find((item) => item.slug === initialOrganization) ??
          organizations[0];
        if (!selectedOrganization) {
          setError("Create or join an organization to configure events.");
          return;
        }

        const result = await getEventConfiguration(
          selectedOrganization.slug,
          eventId,
        );
        if (!active) return;
        setOrganization(selectedOrganization);
        setConfiguration(result);
        setTitle(result.title);
        setDescription(result.description);
        setStartsAt(toLocalDateTime(result.starts_at));
        setVenue(result.venue);
      } catch (caught) {
        if (!active) return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(
            `/login?next=${encodeURIComponent(`/team/events/${eventId}`)}`,
          );
          return;
        }
        setError(
          caught instanceof Error
            ? caught.message
            : "The event configuration could not be loaded.",
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadConfiguration();
    return () => {
      active = false;
    };
  }, [eventId, initialOrganization, router]);

  async function saveConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organization || !configuration || saving) return;

    setError("");
    setNotice("");
    const startsAtDate = new Date(startsAt);
    if (Number.isNaN(startsAtDate.getTime())) {
      setError("Choose a valid event date and time.");
      return;
    }

    setSaving(true);
    try {
      const updated = await updateEventConfiguration(
        organization.slug,
        eventId,
        {
          title: title.trim(),
          description: description.trim(),
          starts_at: startsAtDate.toISOString(),
          venue: venue.trim(),
        },
      );
      setConfiguration(updated);
      setTitle(updated.title);
      setDescription(updated.description);
      setStartsAt(toLocalDateTime(updated.starts_at));
      setVenue(updated.venue);
      setNotice("Event configuration saved.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The event configuration could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  const eventQuery = `organization=${encodeURIComponent(organization?.slug ?? initialOrganization ?? "")}&event_id=${eventId}`;

  return (
    <main className="operations-screen">
      <header className="operations-header">
        <Link className="operations-brand" href="/">
          <span className="brand-mark"><span /></span>
          <span>eventflow</span>
        </Link>
        <div className="operations-crumb">
          <span>{organization?.name ?? "Workspace"}</span>
          <span aria-hidden="true">/</span>
          <strong>Event settings</strong>
        </div>
        <Link className="operations-back" href="/">
          <ArrowLeft size={14} /> Back to dashboard
        </Link>
      </header>

      <section className="operations-content">
        <header className="operations-title">
          <div>
            <span className="operations-eyebrow">EVENT CONFIGURATION</span>
            <h1>{configuration?.title ?? "Event settings"}</h1>
            <p>Update the event details shown to your guests.</p>
          </div>
        </header>

        <nav className="operations-nav" aria-label="Event configuration">
          <Link className="operations-nav-link is-active" aria-current="page" href={`/team/events/${eventId}?${eventQuery}`}>
            Event details
          </Link>
          <Link className="operations-nav-link" href={`/team/box-office?${eventQuery}`}>
            Box office
          </Link>
          <Link className="operations-nav-link" href={`/team/seating?${eventQuery}`}>
            Seating
          </Link>
          <Link className="operations-nav-link" href={`/team/check-in?${eventQuery}`}>
            Check-in
          </Link>
        </nav>

        {loading ? (
          <div className="operations-loading" aria-label="Loading event configuration">
            <span /><span /><span />
          </div>
        ) : error && !configuration ? (
          <div className="operations-alert" role="alert">{error}</div>
        ) : configuration ? (
          <section className="event-settings-panel">
            <div className="event-settings-heading">
              <div>
                <h2>Event details</h2>
                <p>Changes are saved to this event immediately.</p>
              </div>
              <span className={`status-pill status-pill--${configuration.status.replace("_", "-")}`}>
                <i />{configuration.status.replace("_", " ")}
              </span>
            </div>

            <form className="event-settings-form" onSubmit={saveConfiguration}>
              <label>
                Event name
                <input
                  autoComplete="off"
                  maxLength={180}
                  onChange={(change) => setTitle(change.target.value)}
                  required
                  value={title}
                />
              </label>
              <label>
                Description
                <textarea
                  maxLength={5000}
                  onChange={(change) => setDescription(change.target.value)}
                  rows={5}
                  value={description}
                />
              </label>
              <div className="event-settings-grid">
                <label>
                  Date and start time
                  <span className="event-settings-input-icon">
                    <CalendarDays aria-hidden="true" size={16} />
                    <input
                      onChange={(change) => setStartsAt(change.target.value)}
                      required
                      type="datetime-local"
                      value={startsAt}
                    />
                  </span>
                </label>
                <label>
                  Venue
                  <span className="event-settings-input-icon">
                    <MapPin aria-hidden="true" size={16} />
                    <input
                      autoComplete="street-address"
                      maxLength={240}
                      onChange={(change) => setVenue(change.target.value)}
                      required
                      value={venue}
                    />
                  </span>
                </label>
              </div>

              {error && <p className="event-settings-message is-error" role="alert"><CircleAlert size={15} />{error}</p>}
              {notice && <p className="event-settings-message" role="status"><Check size={15} />{notice}</p>}

              <div className="event-settings-actions">
                <button className="button button-primary" disabled={saving} type="submit">
                  <Save size={15} />{saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </section>
        ) : null}
      </section>
    </main>
  );
}
