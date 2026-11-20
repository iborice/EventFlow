"use client";

import {
  ArrowUpRight,
  Archive,
  Bell,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Command,
  Download,
  Ellipsis,
  EyeOff,
  Filter,
  LayoutDashboard,
  MapPin,
  Moon,
  Plus,
  Search,
  Settings2,
  Sun,
  Upload,
  Ticket,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { z } from "zod";
import { EventCreateDialog } from "@/app/event-create-dialog";
import {
  ApiError,
  apiRequest,
  getCurrentUser,
  getOrganizationDashboard,
  getOrganizations,
  signOut,
  type DashboardEvent,
  getEventLifecycle,
  type EventLifecycleFilter,
  type Organization,
  type OrganizationDashboard,
  type User,
} from "@/lib/organizations";

const navigation = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Events", icon: CalendarDays },
  { label: "Orders", icon: Ticket },
  { label: "Audience", icon: Users },
];
const noEvents: DashboardEvent[] = [];
const eventLifecycleFilters: EventLifecycleFilter[] = [
  "Tous les événements",
  "À venir",
  "Terminé",
  "Archive",
];

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);

const formatCount = (amount: number) =>
  new Intl.NumberFormat("en-US").format(amount);

const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(new Date(value));

const formatStatus = (status: DashboardEvent["status"]) => {
  if (status === "published") return "Live";
  if (status === "sold_out") return "Sold out";
  return status[0].toUpperCase() + status.slice(1);
};

const eventArt = (id: number) =>
  ["event-art--afterglow", "event-art--studio", "event-art--table", "event-art--design"][
    id % 4
  ];

const eventInitials = (title: string) =>
  title
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();

const formatPercentage = (current: number, previous: number) => {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
};

function subscribeTheme(callback: () => void) {
  window.addEventListener("eventflow-theme-change", callback);
  return () => window.removeEventListener("eventflow-theme-change", callback);
}

function getThemeSnapshot() {
  return window.localStorage.getItem("eventflow-theme") === "dark";
}

function getServerThemeSnapshot() {
  return false;
}

function saveTheme(darkMode: boolean) {
  window.localStorage.setItem("eventflow-theme", darkMode ? "dark" : "light");
  window.dispatchEvent(new Event("eventflow-theme-change"));
}

function RevenueChart({
  points,
}: {
  points: OrganizationDashboard["revenue_trend"];
}) {
  const maximum = Math.max(1, ...points.map((point) => Number(point.revenue)));
  const coordinates = points.map((point, index) => {
    const x = points.length < 2 ? 0 : (index / (points.length - 1)) * 640;
    const y = 200 - (Number(point.revenue) / maximum) * 170;
    return { x, y };
  });
  const line = coordinates
    .map(({ x, y }, index) => `${index ? "L" : "M"}${x} ${y}`)
    .join(" ");
  const area = coordinates.length
    ? `${line} L640 220 L0 220 Z`
    : "";
  const labels = [0, 7, 14, 21, 29]
    .map((index) => points[index])
    .filter((point): point is (typeof points)[number] => Boolean(point));

  return (
    <div className="chart-wrap" aria-label="Daily revenue over the last 30 days">
      <div className="chart-y-labels" aria-hidden="true">
        <span>{formatCurrency(maximum)}</span>
        <span>{formatCurrency(maximum * 0.75)}</span>
        <span>{formatCurrency(maximum * 0.5)}</span>
        <span>{formatCurrency(maximum * 0.25)}</span>
        <span>$0</span>
      </div>
      <svg
        className="revenue-chart"
        viewBox="0 0 640 220"
        role="img"
        aria-labelledby="chart-title chart-desc"
        preserveAspectRatio="none"
      >
        <title id="chart-title">Revenue over the last 30 days</title>
        <desc id="chart-desc">
          Revenue from confirmed ticket orders during the last 30 days.
        </desc>
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#4f46e5" stopOpacity=".16" />
            <stop offset="100%" stopColor="#4f46e5" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[20, 65, 110, 155, 200].map((y) => (
          <line
            key={y}
            x1="0"
            x2="640"
            y1={y}
            y2={y}
            className="chart-grid"
          />
        ))}
        <path
          d={area}
          fill="url(#chart-fill)"
        />
        <path
          d={line}
          fill="none"
          stroke="#4f46e5"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {coordinates.length > 0 && (
          <>
            <circle
              cx={coordinates[coordinates.length - 1].x}
              cy={coordinates[coordinates.length - 1].y}
              r="5"
              fill="#4f46e5"
            />
            <circle
              cx={coordinates[coordinates.length - 1].x}
              cy={coordinates[coordinates.length - 1].y}
              r="9"
              fill="#4f46e5"
              opacity=".14"
            />
          </>
        )}
      </svg>
      <div className="chart-x-labels" aria-hidden="true">
        {labels.map((point) => (
          <span key={point.date}>
            {new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(
              new Date(`${point.date}T12:00:00`),
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const [activeNav, setActiveNav] = useState("Overview");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<EventLifecycleFilter>("Tous les événements");
  const [notice, setNotice] = useState("");
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [updatingEventId, setUpdatingEventId] = useState<number | null>(null);
  const [activeEventMenuId, setActiveEventMenuId] = useState<number | null>(null);
  const [eventMenuPosition, setEventMenuPosition] = useState({ top: 0, left: 0 });
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [dashboard, setDashboard] = useState<OrganizationDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const darkMode = useSyncExternalStore(
    subscribeTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const events = dashboard?.events ?? noEvents;
  const organization = organizations.find(
    (item) => item.slug === organizationSlug,
  );

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  useEffect(() => {
    function syncActiveNav() {
      setActiveNav(
        window.location.pathname === "/events" ||
          new URLSearchParams(window.location.search).get("view") === "events"
          ? "Events"
          : "Overview",
      );
    }

    syncActiveNav();
    window.addEventListener("popstate", syncActiveNav);
    return () => window.removeEventListener("popstate", syncActiveNav);
  }, []);

  useEffect(() => {
    let active = true;
    async function loadWorkspaces() {
      try {
        const [currentUser, workspaces] = await Promise.all([
          getCurrentUser(),
          getOrganizations(),
        ]);
        if (!active) return;
        setUser(currentUser);
        setOrganizations(workspaces);
        setOrganizationSlug(workspaces[0]?.slug ?? "");
        if (!workspaces.length) setLoading(false);
      } catch (requestError) {
        if (!active) return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          router.push("/login");
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Your workspace could not be loaded.",
        );
        setLoading(false);
      }
    }
    void loadWorkspaces();
    return () => {
      active = false;
    };
  }, [router]);

  useEffect(() => {
    if (!organizationSlug) return;
    let active = true;
    getOrganizationDashboard(organizationSlug)
      .then((data) => {
        if (active) setDashboard(data);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          router.push("/login");
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Your dashboard could not be loaded.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [organizationSlug, router]);

  const visibleEvents = useMemo(
    () =>
      events.filter((event) => {
        const matchesQuery =
          `${event.title} ${event.venue}`.toLowerCase().includes(query.toLowerCase());
        const matchesStatus =
          statusFilter === "Tous les événements" ||
          getEventLifecycle(event) === statusFilter;
        return matchesQuery && matchesStatus;
      }),
    [events, query, statusFilter],
  );

  function positionEventMenu(
    eventId: number,
    details: HTMLDetailsElement,
  ) {
    if (!details.open) {
      setActiveEventMenuId(null);
      return;
    }

    const trigger = details.querySelector<HTMLElement>(".row-more");
    const menu = details.querySelector<HTMLElement>(".event-actions-menu");
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = 190;
    const menuHeight = menu.offsetHeight || 144;
    const left = Math.max(
      8,
      Math.min(
        triggerRect.right - menuWidth,
        window.innerWidth - menuWidth - 8,
      ),
    );
    const preferredTop = triggerRect.bottom + 6;
    const top =
      preferredTop + menuHeight <= window.innerHeight - 8
        ? preferredTop
        : Math.max(8, triggerRect.top - menuHeight - 6);

    setActiveEventMenuId(eventId);
    setEventMenuPosition({ top, left });
  }
  const revenueChange = dashboard
    ? formatPercentage(
        Number(dashboard.revenue_last_30_days),
        Number(dashboard.revenue_previous_30_days),
      )
    : null;
  const canCreateEvents = Boolean(organization && organization.role !== "viewer");

  function showNotice(message: string, isError = false) {
    setNotice(message);
    setNoticeIsError(isError);
  }

  const closeEventDialog = useCallback(() => setEventDialogOpen(false), []);
  const addEventToDashboard = useCallback((createdEvent: DashboardEvent) => {
    setDashboard((current) =>
      current
        ? {
            ...current,
            events: [...current.events, createdEvent].sort((left, right) =>
              left.starts_at.localeCompare(right.starts_at),
            ),
            event_count: current.event_count + 1,
            active_event_count:
              current.active_event_count +
              (createdEvent.status === "published" ? 1 : 0),
          }
        : current,
    );
    showNotice(
      createdEvent.status === "published"
        ? `${createdEvent.title} is published.`
        : `${createdEvent.title} was saved as a draft.`,
    );
  }, []);

  async function handleSignOut() {
    try {
      await signOut();
      router.push("/login");
    } catch (signOutError) {
      showNotice(
        signOutError instanceof Error
          ? signOutError.message
          : "Could not sign out. Please try again.",
        true,
      );
    }
  }

  async function updateEventStatus(
    event: DashboardEvent,
    status: "draft" | "published" | "cancelled",
  ) {
    const canChangeStatus =
      status === "published"
        ? event.status === "draft"
        : status === "draft"
          ? event.status === "published" || event.status === "sold_out"
          : event.status !== "cancelled";
    if (!organization || !canChangeStatus || updatingEventId !== null) {
      return;
    }

    setUpdatingEventId(event.id);
    try {
      const updatedEvent = await apiRequest<DashboardEvent>(
        `/organizations/${encodeURIComponent(organization.slug)}/events/${event.id}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({ status }),
        },
      );
      setDashboard((current) => {
        if (!current) return current;
        const previous = current.events.find((item) => item.id === updatedEvent.id);
        const wasActive =
          previous?.status === "published" || previous?.status === "sold_out";
        const isActive =
          updatedEvent.status === "published" || updatedEvent.status === "sold_out";
        return {
          ...current,
          events: current.events.map((item) =>
            item.id === updatedEvent.id ? updatedEvent : item,
          ),
          active_event_count:
            current.active_event_count +
            Number(isActive) - Number(wasActive),
        };
      });
      showNotice(
        status === "published"
          ? `${updatedEvent.title} is published and its public page is live.`
          : status === "cancelled"
            ? `${updatedEvent.title} a été archivé.`
            : `${updatedEvent.title} a été clôturé et enregistré comme brouillon.`,
      );
    } catch (statusError) {
      showNotice(
        statusError instanceof Error
          ? statusError.message
          : `${event.title} status could not be updated. Please try again.`,
        true,
      );
    } finally {
      setUpdatingEventId(null);
    }
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formData = new FormData(event.currentTarget);
    const name = z
      .string()
      .trim()
      .min(1, "Enter your organization name.")
      .max(180, "Organization names must be 180 characters or fewer.")
      .safeParse(formData.get("organization_name"));
    if (!name.success) {
      setError(name.error.issues[0]?.message ?? "Enter a valid organization name.");
      return;
    }
    setCreatingOrganization(true);
    try {
      const created = await apiRequest<Organization>("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: name.data }),
      });
      setOrganizations((current) => [...current, created]);
      setOrganizationSlug(created.slug);
      setOrganizationName("");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The workspace could not be created.",
      );
    } finally {
      setCreatingOrganization(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link aria-label="EventFlow home" className="brand" href="/">
          <span className="brand-mark"><span /></span>
          <span>eventflow</span>
        </Link>

        <label className="workspace-switcher">
          <span className="workspace-avatar">{organization?.name[0] ?? "?"}</span>
          <span className="workspace-copy">
            <select
              aria-label="Switch workspace"
              className="workspace-select"
                  onChange={(event) => {
                    setLoading(true);
                    setError("");
                    setOrganizationSlug(event.target.value);
                  }}
              value={organizationSlug}
            >
              {organizations.map((workspace) => (
                <option key={workspace.id} value={workspace.slug}>
                  {workspace.name}
                </option>
              ))}
            </select>
            <small>{organization?.role ?? "Workspace"}</small>
          </span>
          <ChevronDown size={16} />
        </label>

        <div className="sidebar-group">
          <span className="sidebar-label">WORKSPACE</span>
          <nav aria-label="Main navigation" className="side-nav">
            {navigation.map(({ label, icon: Icon }) => {
              const className = `nav-item ${activeNav === label ? "nav-item--active" : ""}`;
              if (label === "Overview" || label === "Events") {
                return (
                  <Link
                    aria-label={label}
                    aria-current={activeNav === label ? "page" : undefined}
                    className={className}
                    href={label === "Events" ? "/events" : "/"}
                    key={label}
                    onClick={() => setActiveNav(label)}
                  >
                    <Icon size={18} strokeWidth={1.8} />
                    <span>{label}</span>
                  </Link>
                );
              }
              return (
                <button
                  aria-label={label}
                  className={className}
                  key={label}
                  onClick={() => showNotice(`${label} workspace is coming soon.`)}
                >
                  <Icon size={18} strokeWidth={1.8} />
                  <span>{label}</span>
                  {label === "Orders" && <span className="nav-count">12</span>}
                </button>
              );
            })}
            <Link aria-label="Team" className="nav-item" href="/team">
              <Users size={18} strokeWidth={1.8} /><span>Team</span>
            </Link>
            <button aria-label="Reports" className="nav-item" onClick={() => showNotice("Reports are coming soon.")}>
              <BarChart3 size={18} strokeWidth={1.8} /><span>Reports</span>
            </button>
          </nav>
        </div>

        <div className="sidebar-group sidebar-group--tools">
          <span className="sidebar-label">TOOLS</span>
          <button aria-label="Attendees" className="nav-item" onClick={() => showNotice("Audience tools are coming soon.")}>
            <Users size={18} strokeWidth={1.8} /><span>Attendees</span>
          </button>
          <button aria-label="Integrations" className="nav-item" onClick={() => showNotice("Integrations are coming soon.")}>
            <Command size={18} strokeWidth={1.8} /><span>Integrations</span>
          </button>
        </div>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-card-icon"><CircleHelp size={17} /></span>
            <strong>Need a hand?</strong>
            <p>Our team is here to help you grow.</p>
            <button onClick={() => showNotice("Support chat will be available soon.")}>
              Visit help center <ArrowUpRight size={13} />
            </button>
          </div>
          <button aria-label="Settings" className="nav-item" onClick={() => showNotice("Settings are coming soon.")}>
            <Settings2 size={18} strokeWidth={1.8} /><span>Settings</span>
          </button>
          <button
            aria-label={`Sign out ${user?.name ?? "of EventFlow"}`}
            className="profile-switcher"
            onClick={() => void handleSignOut()}
          >
            <span className="profile-avatar">{user?.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("") ?? "?"}</span>
            <span className="profile-copy"><strong>{user?.name ?? "Account"}</strong><small>{user?.email}</small></span>
            <Ellipsis size={18} />
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>{organization?.name ?? "Workspace"}</span><ChevronRight size={15} /><strong>{activeNav}</strong>
          </div>
          <div className="topbar-actions">
            <button aria-label="Toggle dark mode" className="icon-button" onClick={() => saveTheme(!darkMode)}>
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button aria-label="Notifications" className="icon-button notification-button" onClick={() => showNotice("You’re all caught up.")}>
              <Bell size={18} /><i />
            </button>
            <span className="topbar-divider" />
            <button className="avatar-button" aria-label="Sign out" onClick={() => void handleSignOut()}>
              {user?.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("") ?? "?"}
            </button>
          </div>
        </header>

        <div className="page-content">
          {error && dashboard && <p className="dashboard-error" role="alert">{error}</p>}
          {loading && !dashboard ? (
            <section aria-label="Loading dashboard" className="dashboard-loading">
              <span /><span /><span /><span />
            </section>
          ) : !dashboard ? (
            <section className="dashboard-empty">
              <span className="stat-icon stat-icon--purple"><CalendarDays size={20} /></span>
              <h1>{organizations.length ? "Dashboard unavailable" : "Create your workspace"}</h1>
              <p>
                {organizations.length
                  ? error || "Your workspace dashboard could not be loaded."
                  : "Set up an organization to manage events and invite your team."}
              </p>
              {organizations.length ? (
                <button className="button button-quiet" onClick={() => window.location.reload()}>
                  Try again
                </button>
              ) : (
                <form className="workspace-create-form" onSubmit={createOrganization}>
                  <label>
                    <span className="sr-only">Organization name</span>
                    <input
                      autoComplete="organization"
                      name="organization_name"
                      onChange={(event) => setOrganizationName(event.target.value)}
                      placeholder="Organization name"
                      required
                      value={organizationName}
                    />
                  </label>
                  <button className="button button-primary" disabled={creatingOrganization} type="submit">
                    {creatingOrganization ? "Creating..." : "Create workspace"}
                  </button>
                </form>
              )}
            </section>
          ) : (
          <>
          {activeNav === "Overview" && (
            <>
          <div className="welcome-row">
            <div>
              <div className="eyebrow"><span className="eyebrow-dot" /> {new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date()).toUpperCase()}</div>
              <h1>Good morning, {user?.name.split(/\s+/)[0] ?? "there"} <span className="wave">✦</span></h1>
              <p className="welcome-copy">Here’s what’s happening with your events today.</p>
            </div>
            {canCreateEvents && (
              <button
                className="button button-primary create-button"
                onClick={() => setEventDialogOpen(true)}
                type="button"
              >
                <Plus size={18} /> Create event
              </button>
            )}
          </div>

          <section aria-label="Performance overview" className="stats-grid">
            <article className="stat-card">
              <div className="stat-top"><span className="stat-label">Total revenue</span><span className="stat-icon stat-icon--purple"><Ticket size={17} /></span></div>
              <div className="stat-value">{formatCurrency(Number(dashboard.total_revenue))}</div>
              <div className="stat-foot"><span className={`trend ${revenueChange === null || revenueChange >= 0 ? "trend--up" : "trend--down"}`}>{revenueChange === null ? "—" : `${revenueChange > 0 ? "+" : ""}${revenueChange.toFixed(1)}%`}</span><span>last 30 days</span></div>
              <div className="stat-spark stat-spark--purple" aria-hidden="true"><svg viewBox="0 0 120 30"><path d="M0 25 C15 24 12 18 27 20 S42 11 56 16 S72 18 84 8 S102 15 120 2" /></svg></div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span className="stat-label">Tickets sold</span><span className="stat-icon stat-icon--blue"><Ticket size={17} /></span></div>
              <div className="stat-value">{formatCount(dashboard.tickets_sold)}</div>
              <div className="stat-foot"><span className="trend trend--up">{dashboard.event_count}</span><span>total events</span></div>
              <div className="stat-spark stat-spark--blue" aria-hidden="true"><svg viewBox="0 0 120 30"><path d="M0 22 C16 22 15 15 31 18 S43 14 57 16 S72 10 87 12 S105 6 120 3" /></svg></div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span className="stat-label">Active events</span><span className="stat-icon stat-icon--orange"><CalendarDays size={17} /></span></div>
              <div className="stat-value">{formatCount(dashboard.active_event_count)}</div>
              <div className="stat-foot"><span className="trend trend--up">{dashboard.event_count}</span><span>created events</span></div>
              <div className="stat-spark stat-spark--orange" aria-hidden="true"><svg viewBox="0 0 120 30"><path d="M0 25 C14 21 19 24 32 17 S50 19 60 12 S76 17 89 9 S105 12 120 2" /></svg></div>
            </article>
            <article className="stat-card">
              <div className="stat-top"><span className="stat-label">Team members</span><span className="stat-icon stat-icon--green"><Users size={17} /></span></div>
              <div className="stat-value">{formatCount(dashboard.member_count)}</div>
              <div className="stat-foot"><Link href="/team" className="trend trend--up">Manage team</Link></div>
              <div className="stat-spark stat-spark--green" aria-hidden="true"><svg viewBox="0 0 120 30"><path d="M0 5 C12 8 19 7 31 12 S48 8 62 13 S78 11 91 18 S106 14 120 23" /></svg></div>
            </article>
          </section>

          <section className="insights-grid">
            <article className="panel revenue-panel">
              <div className="panel-heading">
                <div><h2>Revenue over time</h2><p>Keep an eye on how your events are performing.</p></div>
                <button className="select-button">Last 30 days <ChevronDown size={15} /></button>
              </div>
              <div className="revenue-total"><strong>{formatCurrency(Number(dashboard.revenue_last_30_days))}</strong>{revenueChange !== null && <span className={`trend ${revenueChange >= 0 ? "trend--up" : "trend--down"}`}>{revenueChange > 0 ? "+" : ""}{revenueChange.toFixed(1)}%</span>}<small>vs. previous 30 days</small></div>
              <RevenueChart points={dashboard.revenue_trend} />
            </article>

            <article className="panel activity-panel">
              <div className="panel-heading">
                <div><h2>Recent activity</h2><p>Latest updates from your events.</p></div>
                <button aria-label="More activity options" className="icon-button panel-more"><Ellipsis size={19} /></button>
              </div>
              <div className="activity-list">
                {dashboard.recent_orders.length ? dashboard.recent_orders.map((order) => (
                  <div className="activity-item" key={order.id}>
                    <span className="activity-icon activity-icon--ticket"><Ticket size={16} /></span>
                    <div><p><strong>{order.customer_name}</strong> purchased a ticket for {order.event_title}</p><small>{formatDate(order.created_at)} · {formatCurrency(Number(order.total))}</small></div>
                  </div>
                )) : <p className="activity-empty">Confirmed orders will appear here.</p>}
              </div>
              <button className="activity-link" onClick={() => showNotice("The orders view is coming soon.")}>View all activity <ArrowUpRight size={14} /></button>
            </article>
          </section>
            </>
          )}

          <section
            aria-labelledby="events-title"
            className={activeNav === "Events" ? "panel events-panel events-panel--standalone" : "panel events-panel"}
            id="events-panel"
          >
            <div className="events-heading">
              <div>
                <h2 id="events-title">{activeNav === "Events" ? "Events" : "Your events"} <span className="event-count">{events.length}</span></h2>
                <p>Manage and track all your events in one place.</p>
              </div>
              <div className="event-controls">
                {activeNav === "Events" && canCreateEvents && (
                  <button
                    className="button button-primary events-create-button"
                    onClick={() => setEventDialogOpen(true)}
                    type="button"
                  >
                    <Plus size={15} /> Create event
                  </button>
                )}
                <label className="search-field">
                  <Search size={16} /><span className="sr-only">Search events</span>
                  <input onChange={(event) => setQuery(event.target.value)} placeholder="Search events..." value={query} />
                  <kbd>/</kbd>
                </label>
                <details className="filter-button">
                  <summary aria-label="Filtrer les événements" className="filter-button-trigger">
                    <Filter aria-hidden="true" size={15} />
                    <span>{statusFilter}</span>
                    <ChevronDown aria-hidden="true" size={14} />
                  </summary>
                  <div aria-label="Filtrer les événements" className="filter-menu" role="group">
                    {eventLifecycleFilters.map((filter) => (
                      <button
                        aria-pressed={statusFilter === filter}
                        className={statusFilter === filter ? "is-selected" : ""}
                        key={filter}
                        onClick={(clickEvent) => {
                          setStatusFilter(filter);
                          clickEvent.currentTarget.closest("details")?.removeAttribute("open");
                        }}
                        type="button"
                      >
                        <span>{filter}</span>
                        {statusFilter === filter && <Check aria-hidden="true" size={15} />}
                      </button>
                    ))}
                  </div>
                </details>
                <button className="icon-button export-button" aria-label="Export events" onClick={() => showNotice("Event exports are coming soon.")}><Download size={17} /></button>
              </div>
            </div>

            {events.length === 0 ? (
              <div className="empty-state">
                <span><CalendarDays size={21} /></span>
                <strong>No events yet</strong>
                <p>Create an event to start selling tickets.</p>
                {canCreateEvents && activeNav !== "Events" && (
                  <button
                    className="button button-primary"
                    onClick={() => setEventDialogOpen(true)}
                    type="button"
                  >
                    <Plus size={15} /> Create event
                  </button>
                )}
              </div>
            ) : visibleEvents.length > 0 ? (
              <div className="events-table-wrap">
                <table className="events-table">
                  <thead><tr><th>EVENT</th><th>DATE & VENUE</th><th>TICKETS SOLD</th><th>REVENUE</th><th>STATUS</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>{visibleEvents.map((event) => {
                    const percentage = Math.min(100, Math.round((event.sold / event.capacity) * 100));
                    const status = formatStatus(event.status);
                    const initials = eventInitials(event.title);
                    const hasPublicPage = event.status === "published" || event.status === "sold_out";
                    return <tr key={event.id}>
                      <td>
                        <div className="event-name-cell">
                          <span className={`event-art ${eventArt(event.id)}`}><span>{initials}</span></span>
                          {hasPublicPage ? (
                            <Link href={`/events/${encodeURIComponent(event.slug)}`}>
                              <strong>{event.title}</strong>
                            </Link>
                          ) : (
                            <button
                              aria-label={`Learn why ${event.title} has no public page`}
                              className="event-title-unavailable"
                              onClick={() => showNotice("Only published events have a public details page. Publish this event to make it available.")}
                              title="Publish this event to make its public page available"
                              type="button"
                            >
                              <strong>{event.title}</strong>
                            </button>
                          )}
                          <Link aria-label={`Open operations for ${event.title}`} className="event-tools-link" href={`/team/box-office?organization=${encodeURIComponent(organizationSlug)}&event_id=${event.id}`}><ArrowUpRight size={13} /></Link>
                        </div>
                      </td>
                      <td><div className="date-cell"><strong>{formatDate(event.starts_at)}</strong><span><MapPin size={12} />{event.venue}</span></div></td>
                      <td><div className="sold-cell"><strong>{formatCount(event.sold)} <span>/ {formatCount(event.capacity)}</span></strong><div className="progress-track"><span style={{ width: `${percentage}%` }} /></div></div></td>
                      <td className="revenue-cell">{formatCurrency(Number(event.revenue))}</td>
                      <td><span className={`status-pill status-pill--${status.toLowerCase().replace(" ", "-")}`}><i />{status}</span></td>
                      <td>
                        <details
                          className="event-actions"
                          onToggle={(toggleEvent) => positionEventMenu(event.id, toggleEvent.currentTarget)}
                        >
                          <summary
                            aria-label={`Actions pour ${event.title}`}
                            className="icon-button row-more"
                            title="Actions"
                          >
                            <Ellipsis size={18} />
                          </summary>
                          <div
                            className="event-actions-menu"
                            style={activeEventMenuId === event.id ? eventMenuPosition : undefined}
                          >
                            {canCreateEvents && event.status === "draft" && (
                              <button
                                disabled={updatingEventId !== null}
                                onClick={(clickEvent) => {
                                  clickEvent.currentTarget.closest("details")?.removeAttribute("open");
                                  void updateEventStatus(event, "published");
                                }}
                                type="button"
                              >
                                <Upload size={14} />
                                {updatingEventId === event.id ? "Publication…" : "Publish"}
                              </button>
                            )}
                            {canCreateEvents && (event.status === "published" || event.status === "sold_out") && (
                              <button
                                disabled={updatingEventId !== null}
                                onClick={(clickEvent) => {
                                  clickEvent.currentTarget.closest("details")?.removeAttribute("open");
                                  void updateEventStatus(event, "draft");
                                }}
                                type="button"
                              >
                                <EyeOff size={14} />
                                {updatingEventId === event.id ? "Unpublishing…" : "Unpublish"}
                              </button>
                            )}
                            {canCreateEvents && event.status !== "cancelled" && (
                              <button
                                disabled={updatingEventId !== null}
                                onClick={(clickEvent) => {
                                  clickEvent.currentTarget.closest("details")?.removeAttribute("open");
                                  void updateEventStatus(event, "cancelled");
                                }}
                                type="button"
                              >
                                <Archive size={14} />
                                {updatingEventId === event.id ? "Archivage…" : "Archiver l’événement"}
                              </button>
                            )}
                            <Link
                              href={`/team/events/${event.id}?organization=${encodeURIComponent(organizationSlug)}`}
                              onClick={(clickEvent) => clickEvent.currentTarget.closest("details")?.removeAttribute("open")}
                            >
                              <Settings2 size={14} />
                              Gérer l’événement
                            </Link>
                          </div>
                        </details>
                      </td>
                    </tr>;
                  })}</tbody>
                </table>
                <div className="mobile-events">{visibleEvents.map((event) => {
                  const status = formatStatus(event.status);
                  return <article className="mobile-event-card" key={event.id}>
                  <div className="mobile-event-top"><span className={`event-art ${eventArt(event.id)}`}><span>{eventInitials(event.title)}</span></span><div className="mobile-event-name"><strong>{event.title}</strong><span><MapPin size={12} />{event.venue}</span></div>
                    <details
                      className="event-actions mobile-event-actions"
                      onToggle={(toggleEvent) => positionEventMenu(event.id, toggleEvent.currentTarget)}
                    >
                      <summary aria-label={`Actions pour ${event.title}`} className="icon-button row-more" title="Actions"><Ellipsis size={18} /></summary>
                      <div
                        className="event-actions-menu"
                        style={activeEventMenuId === event.id ? eventMenuPosition : undefined}
                      >
                        {canCreateEvents && event.status === "draft" && <button disabled={updatingEventId !== null} onClick={(clickEvent) => { clickEvent.currentTarget.closest("details")?.removeAttribute("open"); void updateEventStatus(event, "published"); }} type="button"><Upload size={14} />{updatingEventId === event.id ? "Publication…" : "Publish"}</button>}
                        {canCreateEvents && (event.status === "published" || event.status === "sold_out") && <button disabled={updatingEventId !== null} onClick={(clickEvent) => { clickEvent.currentTarget.closest("details")?.removeAttribute("open"); void updateEventStatus(event, "draft"); }} type="button"><EyeOff size={14} />{updatingEventId === event.id ? "Unpublishing…" : "Unpublish"}</button>}
                        {canCreateEvents && event.status !== "cancelled" && <button disabled={updatingEventId !== null} onClick={(clickEvent) => { clickEvent.currentTarget.closest("details")?.removeAttribute("open"); void updateEventStatus(event, "cancelled"); }} type="button"><Archive size={14} />{updatingEventId === event.id ? "Archivage…" : "Archiver l’événement"}</button>}
                        <Link href={`/team/events/${event.id}?organization=${encodeURIComponent(organizationSlug)}`} onClick={(clickEvent) => clickEvent.currentTarget.closest("details")?.removeAttribute("open")}><Settings2 size={14} />Gérer l’événement</Link>
                      </div>
                    </details>
                  </div>
                  <div className="mobile-event-bottom"><span>{formatDate(event.starts_at)}</span><strong>{formatCurrency(Number(event.revenue))}</strong><span className={`status-pill status-pill--${status.toLowerCase().replace(" ", "-")}`}><i />{status}</span></div>
                  <div className="mobile-progress"><span>{event.sold} / {event.capacity} tickets</span><div className="progress-track"><span style={{ width: `${Math.min(100, (event.sold / event.capacity) * 100)}%` }} /></div></div>
                  <Link className="mobile-operation-link" href={`/team/box-office?organization=${encodeURIComponent(organizationSlug)}&event_id=${event.id}`}>Open event operations <ArrowUpRight size={13} /></Link>
                </article>;
                })}</div>
                <div className="table-footer"><span>Showing <strong>{visibleEvents.length}</strong> of <strong>{events.length}</strong> events</span><div><button aria-label="Previous page" className="pagination-button" disabled><ChevronLeft size={16} /></button><button className="pagination-current">1</button><button aria-label="Next page" className="pagination-button" disabled><ChevronRight size={16} /></button></div></div>
              </div>
            ) : <div className="empty-state"><span><Search size={21} /></span><strong>No events found</strong><p>Try adjusting your search or filters.</p><button className="button button-quiet" onClick={() => { setQuery(""); setStatusFilter("Tous les événements"); }}>Clear filters</button></div>}
          </section>

          <footer className="page-footer"><span>© {new Date().getFullYear()} EventFlow, Inc.</span><span><a href="#privacy">Privacy</a><a href="#terms">Terms</a><a href="#status"><i className="footer-status" /> All systems operational</a></span></footer>
          </>
          )}
        </div>
      </main>

      {notice && <div className={noticeIsError ? "toast toast--error" : "toast"} role={noticeIsError ? "alert" : "status"}><span>{noticeIsError ? <CircleAlert size={16} /> : <Check size={16} />}</span>{notice}<button aria-label="Dismiss notification" onClick={() => showNotice("")}><X size={16} /></button></div>}
      {eventDialogOpen && organization && canCreateEvents && (
        <EventCreateDialog
          onClose={closeEventDialog}
          onCreated={addEventToDashboard}
          organizationSlug={organization.slug}
        />
      )}
      {canCreateEvents && (
        <button
          aria-label="Create event"
          className="mobile-create"
          onClick={() => setEventDialogOpen(true)}
          type="button"
        >
          <Plus size={23} />
        </button>
      )}
    </div>
  );
}
