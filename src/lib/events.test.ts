import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventSchema, eventSchema } from "./events";
import { getPublicEvent, resolveInitialTicketId } from "./public-event";

describe("createEventSchema", () => {
  it("trims text and coerces a positive integer capacity", () => {
    expect(
      createEventSchema.parse({
        name: "  Afterglow  ",
        date: "2026-12-05",
        venue: " Pier 27 ",
        capacity: "250",
      }),
    ).toEqual({
      name: "Afterglow",
      date: "2026-12-05",
      venue: "Pier 27",
      capacity: 250,
    });
  });

  it.each(["", "0", "-2", "2.5", "not-a-number"])(
    "rejects an invalid capacity: %s",
    (capacity) => {
      expect(
        createEventSchema.safeParse({
          name: "Afterglow",
          date: "2026-12-05",
          venue: "Pier 27",
          capacity,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects missing event details", () => {
    expect(
      createEventSchema.safeParse({
        name: " ",
        date: "",
        venue: " ",
        capacity: 25,
      }).success,
    ).toBe(false);
  });
});

describe("eventSchema", () => {
  it("rejects corrupt saved event records", () => {
    expect(
      eventSchema.safeParse({
        id: "not-an-id",
        name: "Afterglow",
        date: "2026-12-05",
        venue: "Pier 27",
        sold: 0,
        capacity: 250,
        revenue: 0,
        status: "Live",
        art: "event-art--afterglow",
        initials: "AF",
      }).success,
    ).toBe(false);
  });
});

describe("getPublicEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveInitialTicketId", () => {
    it("keeps a requested ticket when it exists", () => {
      expect(
        resolveInitialTicketId([{ id: "2" }, { id: "3" }], "3"),
      ).toBe("3");
    });

    it("falls back to an available ticket for an invalid link parameter", () => {
      expect(resolveInitialTicketId([{ id: "2" }], "early")).toBe("2");
    });

    it("returns an empty selection when there are no tickets", () => {
      expect(resolveInitialTicketId([], "early")).toBe("");
    });
  });

  it("returns a public event from the catalog API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 1,
            title: "Afterglow Festival",
            slug: "afterglow-festival",
            description: "An evening of live music.",
            starts_at: "2026-12-05T19:30:00Z",
            venue: "Pier 27, San Francisco",
            status: "published",
            tickets: [
              {
                id: 2,
                name: "General Admission",
                description: "Standard entry",
                price: "60.00",
                remaining: 50,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(getPublicEvent("afterglow-festival")).resolves.toMatchObject({
      title: "Afterglow Festival",
      tickets: [{ name: "General Admission", price: 60 }],
    });
  });

  it("does not substitute an unrelated event for an unknown slug", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(getPublicEvent("unknown-event")).resolves.toBeUndefined();
  });

  it("maps price tiers and recurring dates from the catalog API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 1,
            title: "Community Night",
            slug: "community-night",
            description: "A recurring event.",
            starts_at: "2026-12-05T19:30:00Z",
            venue: "Pier 27",
            status: "published",
            tickets: [
              {
                id: 2,
                name: "Admission",
                description: "",
                price: "30.00",
                capacity: 10,
                remaining: 8,
                price_tiers: [
                  {
                    id: 3,
                    name: "Early",
                    price: "15.00",
                    capacity: 4,
                    remaining: 2,
                  },
                ],
              },
            ],
            series_id: 4,
            series_dates: [
              { id: 1, slug: "community-night", starts_at: "2026-12-05T19:30:00Z" },
              {
                id: 5,
                slug: "community-night-2",
                starts_at: "2026-12-12T19:30:00Z",
              },
            ],
            has_hidden_tickets: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(getPublicEvent("community-night")).resolves.toMatchObject({
      hasHiddenTickets: true,
      tickets: [
        {
          priceTiers: [{ id: "3", name: "Early", price: 15, remaining: 2 }],
        },
      ],
      seriesDates: [
        { slug: "community-night" },
        { slug: "community-night-2" },
      ],
    });
  });
});
