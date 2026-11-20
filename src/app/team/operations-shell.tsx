"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ApiError,
  getCurrentUser,
  getOrganizationDashboard,
  getOrganizations,
  type DashboardEvent,
  type Organization,
} from "@/lib/organizations";

export type OperationsContext = {
  organization: Organization;
  event: DashboardEvent | null;
  events: DashboardEvent[];
  onEventChange: (eventId: number) => void;
};

export function OperationsShell({
  title,
  description,
  mode,
  initialOrganization,
  initialEventId,
  children,
}: {
  title: string;
  description: string;
  mode: "seating" | "box-office" | "check-in";
  initialOrganization?: string;
  initialEventId?: string;
  children: (context: OperationsContext) => ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationSlug, setOrganizationSlug] = useState(
    initialOrganization ?? "",
  );
  const [events, setEvents] = useState<DashboardEvent[]>([]);
  const [eventId, setEventId] = useState(
    Number.isInteger(Number(initialEventId)) ? Number(initialEventId) : 0,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const organization = organizations.find(
    (workspace) => workspace.slug === organizationSlug,
  );
  const event = events.find((item) => item.id === eventId) ?? null;
  const navigation = useMemo(
    () => [
      { href: "/team/seating", label: "Seat designer", mode: "seating" },
      { href: "/team/box-office", label: "Box office", mode: "box-office" },
      { href: "/team/check-in", label: "Check-in", mode: "check-in" },
    ],
    [],
  );

  useEffect(() => {
    let active = true;
    async function loadOrganizations() {
      try {
        await getCurrentUser();
        const workspaces = await getOrganizations();
        if (!active) return;
        setOrganizations(workspaces);
        const selected =
          workspaces.find((item) => item.slug === initialOrganization) ??
          workspaces[0];
        setOrganizationSlug(selected?.slug ?? "");
        if (!selected) {
          setLoading(false);
          setError("Create or join an organization to use event operations.");
        }
      } catch (caught) {
        if (!active) return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }
        setError(messageFor(caught));
        setLoading(false);
      }
    }
    void loadOrganizations();
    return () => {
      active = false;
    };
  }, [initialOrganization, pathname, router]);

  useEffect(() => {
    if (!organizationSlug) return;
    let active = true;
    getOrganizationDashboard(organizationSlug)
      .then((dashboard) => {
        if (!active) return;
        setEvents(dashboard.events);
        setEventId((current) =>
          dashboard.events.some((item) => item.id === current)
            ? current
            : Number(initialEventId) || dashboard.events[0]?.id || 0,
        );
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setError(messageFor(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organizationSlug, initialEventId]);

  function updateSelection(nextOrganization: string, nextEventId: number) {
    const query = new URLSearchParams();
    query.set("organization", nextOrganization);
    if (nextEventId) query.set("event_id", String(nextEventId));
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  }

  function changeEvent(nextEventId: number) {
    setEventId(nextEventId);
    updateSelection(organizationSlug, nextEventId);
  }

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
          <strong>{title}</strong>
        </div>
        <Link className="operations-back" href="/">Back to dashboard</Link>
      </header>

      <section className="operations-content">
        <header className="operations-title">
          <div>
            <span className="operations-eyebrow">EVENT OPERATIONS</span>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          <div className="operations-selectors">
            {organizations.length > 1 && (
              <label>
                Workspace
                <select
                  onChange={(change) => {
                    setLoading(true);
                    setError("");
                    setEventId(0);
                    setOrganizationSlug(change.target.value);
                    updateSelection(change.target.value, 0);
                  }}
                  value={organizationSlug}
                >
                  {organizations.map((workspace) => (
                    <option key={workspace.id} value={workspace.slug}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {events.length > 0 && (
              <label>
                Event
                <select
                  onChange={(change) => changeEvent(Number(change.target.value))}
                  value={event?.id ?? ""}
                >
                  {events.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title} · {new Date(item.starts_at).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </header>

        <nav className="operations-nav" aria-label="Event operations">
          {navigation.map((item) => (
            <Link
              aria-current={mode === item.mode ? "page" : undefined}
              className={mode === item.mode ? "operations-nav-link is-active" : "operations-nav-link"}
              href={`${item.href}?organization=${encodeURIComponent(organizationSlug)}${eventId ? `&event_id=${eventId}` : ""}`}
              key={item.mode}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        {loading ? (
          <div className="operations-loading" aria-label="Loading event operations">
            <span /><span /><span />
          </div>
        ) : error ? (
          <div className="operations-alert" role="alert">{error}</div>
        ) : !organization ? (
          <div className="operations-empty">No workspace is available.</div>
        ) : !event ? (
          <div className="operations-empty">
            <strong>No events in this workspace yet</strong>
            <span>Create or publish an event to set up event operations.</span>
            <Link className="button button-primary" href="/">Go to dashboard</Link>
          </div>
        ) : (
          children({
            organization,
            event,
            events,
            onEventChange: changeEvent,
          })
        )}
      </section>
    </main>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Event operations could not be loaded.";
}
