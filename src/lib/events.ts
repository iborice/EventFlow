import { z } from "zod";

export const eventSchema = z.object({
  id: z.number(),
  name: z.string().min(1),
  date: z.string().min(1),
  venue: z.string().min(1),
  sold: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
  revenue: z.number().nonnegative(),
  status: z.enum(["Live", "Draft", "Sold out"]),
  art: z.string(),
  initials: z.string(),
});

export const createEventSchema = z.object({
  name: z.string().trim().min(1, "Enter an event name."),
  date: z.string().min(1, "Choose an event date."),
  venue: z.string().trim().min(1, "Enter a venue."),
  capacity: z.coerce.number().int().positive("Capacity must be at least one."),
});

export type EventItem = z.infer<typeof eventSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
