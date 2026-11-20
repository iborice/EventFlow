import { cache } from "react";
import { z } from "zod";

export const apiTicketSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  price: z.string(),
  remaining: z.number().int().nonnegative(),
  price_tiers: z
    .array(
      z.object({
        id: z.number().int(),
        name: z.string(),
        price: z.string(),
        remaining: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});

const apiEventSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  slug: z.string(),
  description: z.string(),
  starts_at: z.string(),
  venue: z.string(),
  status: z.string(),
  tickets: z.array(apiTicketSchema),
  series_id: z.number().int().nullable().optional(),
  series_dates: z
    .array(
      z.object({
        id: z.number().int(),
        slug: z.string(),
        starts_at: z.string(),
      }),
    )
    .default([]),
  has_hidden_tickets: z.boolean().default(false),
  has_seating: z.boolean().default(false),
});

export type PublicPriceTier = {
  id: string;
  name: string;
  price: number;
  remaining: number;
};

export type PublicTicket = {
  id: string;
  name: string;
  description: string;
  price: number;
  remaining: number;
  priceTiers: PublicPriceTier[];
};

export type PublicSeriesDate = {
  slug: string;
  startsAt: string;
  date: string;
  time: string;
};

export type PublicEvent = {
  slug: string;
  title: string;
  startsAt: string;
  date: string;
  time: string;
  venue: string;
  address?: string;
  category: string;
  description: string;
  accent: "afterglow" | "studio" | "table";
  tickets: PublicTicket[];
  seriesDates: PublicSeriesDate[];
  hasHiddenTickets: boolean;
  hasSeating: boolean;
};

export function resolveInitialTicketId(
  tickets: readonly Pick<PublicTicket, "id">[],
  requestedId: string | null,
): string {
  if (requestedId && tickets.some((ticket) => ticket.id === requestedId)) {
    return requestedId;
  }
  return tickets[0]?.id ?? "";
}

const apiBaseUrl = (
  process.env.EVENTFLOW_API_URL ?? "http://127.0.0.1:8000/api/v1"
).replace(/\/+$/, "");

export const getPublicEvent = cache(
  async (slug: string): Promise<PublicEvent | undefined> => {
    const response = await fetch(
      `${apiBaseUrl}/events/${encodeURIComponent(slug)}`,
      { cache: "no-store" },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Event API returned HTTP ${response.status}.`);
    }

    const parsed = apiEventSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("Event API returned an invalid event.");
    }

    const startsAt = new Date(parsed.data.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      throw new Error("Event API returned an invalid start date.");
    }

    const formatDate = (date: Date) =>
      new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      })
        .format(date)
        .toUpperCase();
    const formatTime = (date: Date) =>
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(date);

    return {
      slug: parsed.data.slug,
      title: parsed.data.title,
      startsAt: parsed.data.starts_at,
      date: formatDate(startsAt),
      time: formatTime(startsAt),
      venue: parsed.data.venue,
      address: undefined,
      category: "Live event",
      description: parsed.data.description,
      accent: "afterglow",
      tickets: parsed.data.tickets.map((ticket) => ({
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
      })),
      seriesDates: parsed.data.series_dates.map((date) => {
        const startsAt = new Date(date.starts_at);
        if (Number.isNaN(startsAt.getTime())) {
          throw new Error("Event API returned an invalid series date.");
        }
        return {
          slug: date.slug,
          startsAt: date.starts_at,
          date: formatDate(startsAt),
          time: formatTime(startsAt),
        };
      }),
      hasHiddenTickets: parsed.data.has_hidden_tickets,
      hasSeating: parsed.data.has_seating,
    };
  },
);
