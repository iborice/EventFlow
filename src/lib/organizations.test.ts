import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, getEventLifecycle, type DashboardEvent } from "./organizations";

describe("event lifecycle filters", () => {
  const event = (overrides: Partial<DashboardEvent>): DashboardEvent => ({
    id: 1,
    title: "Community Night",
    slug: "community-night",
    starts_at: "2026-12-05T19:30:00Z",
    venue: "Main Hall",
    sold: 0,
    capacity: 100,
    revenue: "0",
    status: "published",
    ...overrides,
  });

  it("classifies future, past, and cancelled events", () => {
    const now = new Date("2026-11-19T15:00:00Z");

    expect(getEventLifecycle(event({}), now)).toBe("À venir");
    expect(getEventLifecycle(event({ starts_at: "2026-11-18T19:30:00Z" }), now)).toBe("Terminé");
    expect(getEventLifecycle(event({ status: "cancelled" }), now)).toBe("Archive");
  });
});

describe("organization API requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a CSRF token before sending authenticated mutations", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrf_token: "csrf-value" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 8, role: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequest<{ id: number; role: string }>("/organizations", {
        method: "POST",
        body: JSON.stringify({ name: "Studio North" }),
      }),
    ).resolves.toEqual({ id: 8, role: "admin" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/csrf",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const mutationOptions = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(mutationOptions.headers).get("X-CSRFToken")).toBe(
      "csrf-value",
    );
    expect(mutationOptions.credentials).toBe("same-origin");
  });

  it("surfaces API errors instead of treating failed mutations as successful", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrf_token: "csrf-value" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Only admins can invite members." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      apiRequest("/organizations/studio-north/invitations", {
        method: "POST",
        body: JSON.stringify({ email: "team@example.com", role: "viewer" }),
      }),
    ).rejects.toMatchObject({
      message: "Only admins can invite members.",
      status: 403,
    } satisfies Partial<ApiError>);
  });
});
