export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Organization {
  id: number;
  name: string;
  slug: string;
  role: "admin" | "organizer" | "viewer";
  member_count: number;
}

export interface DashboardEvent {
  id: number;
  title: string;
  slug: string;
  starts_at: string;
  venue: string;
  sold: number;
  capacity: number;
  revenue: string;
  status: "draft" | "published" | "cancelled" | "sold_out";
}

export interface EventConfiguration extends Pick<
  DashboardEvent,
  "id" | "title" | "starts_at" | "venue" | "status"
> {
  description: string;
}

export type EventConfigurationInput = Pick<
  EventConfiguration,
  "title" | "description" | "starts_at" | "venue"
>;

export type EventLifecycleFilter = "Tous les événements" | "À venir" | "Terminé" | "Archive";

export function getEventLifecycle(
  event: DashboardEvent,
  now: Date = new Date(),
): Exclude<EventLifecycleFilter, "Tous les événements"> {
  if (event.status === "cancelled") return "Archive";

  const start = new Date(event.starts_at);
  if (Number.isNaN(start.getTime())) return "Terminé";
  return start.getTime() > now.getTime() ? "À venir" : "Terminé";
}

export interface RecentOrder {
  id: string;
  event_title: string;
  customer_name: string;
  total: string;
  created_at: string;
}

export interface OrganizationDashboard {
  organization: Organization;
  total_revenue: string;
  revenue_last_30_days: string;
  revenue_previous_30_days: string;
  tickets_sold: number;
  event_count: number;
  active_event_count: number;
  member_count: number;
  events: DashboardEvent[];
  revenue_trend: { date: string; revenue: string }[];
  recent_orders: RecentOrder[];
}

export interface MemberEventAccess {
  event_id: number;
  event_title: string;
  role: "organizer" | "viewer";
}

export interface OrganizationMember {
  id: number;
  name: string;
  email: string;
  role: "admin" | "organizer" | "viewer";
  joined_at: string;
  event_access: MemberEventAccess[];
}

export interface OrganizationInvitation {
  id: number;
  email: string;
  role: "organizer" | "viewer";
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  invite_url?: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getCsrfToken(): Promise<string> {
  const response = await fetch("/api/v1/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new ApiError("Could not start a secure session. Please try again.", response.status);
  }
  const result = (await response.json()) as { csrf_token: string };
  return result.csrf_token;
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    headers.set("X-CSRFToken", await getCsrfToken());
  }

  const response = await fetch(`/api/v1${path}`, {
    ...options,
    method,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    try {
      const body: unknown = await response.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "detail" in body &&
        typeof body.detail === "string"
      ) {
        message = body.detail;
      }
    } catch {
      // Some upstream errors do not include a JSON response body.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const getCurrentUser = () => apiRequest<User>("/auth/session");

export const getOrganizations = () =>
  apiRequest<Organization[]>("/organizations");

export const getOrganizationDashboard = (slug: string) =>
  apiRequest<OrganizationDashboard>(
    `/organizations/${encodeURIComponent(slug)}/dashboard`,
  );

export const getEventConfiguration = (
  organizationSlug: string,
  eventId: number,
) =>
  apiRequest<EventConfiguration>(
    `/organizations/${encodeURIComponent(organizationSlug)}/events/${eventId}/configuration`,
  );

export const updateEventConfiguration = (
  organizationSlug: string,
  eventId: number,
  input: EventConfigurationInput,
) =>
  apiRequest<EventConfiguration>(
    `/organizations/${encodeURIComponent(organizationSlug)}/events/${eventId}/configuration`,
    { method: "PATCH", body: JSON.stringify(input) },
  );

export const getOrganizationMembers = (slug: string) =>
  apiRequest<OrganizationMember[]>(
    `/organizations/${encodeURIComponent(slug)}/members`,
  );

export const getOrganizationInvitations = (slug: string) =>
  apiRequest<OrganizationInvitation[]>(
    `/organizations/${encodeURIComponent(slug)}/invitations`,
  );

export const signOut = () =>
  apiRequest<{ signed_out: boolean }>("/auth/logout", { method: "POST" });
