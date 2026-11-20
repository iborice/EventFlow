import { z } from "zod";

const seatZoneSchema = z.object({
  key: z.string(),
  name: z.string(),
  color: z.string(),
  ticket_type_id: z.number().int(),
  ticket_name: z.string(),
  price: z.string(),
});

const seatSchema = z.object({
  id: z.number().int(),
  label: z.string(),
  row: z.string(),
  number: z.number().int(),
  x: z.number().int(),
  y: z.number().int(),
  zone_key: z.string(),
  zone_color: z.string(),
  ticket_type_id: z.number().int(),
  blocked: z.boolean(),
  available: z.boolean(),
});

export const seatMapSchema = z.object({
  width: z.number().int(),
  height: z.number().int(),
  zones: z.array(seatZoneSchema),
  seats: z.array(seatSchema),
});

export type SeatMapData = z.infer<typeof seatMapSchema>;
export type SeatData = SeatMapData["seats"][number];

export async function getPublicSeatMap(slug: string): Promise<SeatMapData> {
  const response = await fetch(
    `/api/v1/events/${encodeURIComponent(slug)}/seating`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "This event does not have a reserved seating map."
        : `Could not load seating (HTTP ${response.status}).`,
    );
  }
  const parsed = seatMapSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("The event returned an invalid seating map.");
  }
  return parsed.data;
}

export function bestAvailableSeats(
  seats: SeatData[],
  ticketTypeId: number,
  quantity: number,
): SeatData[] {
  const available = seats
    .filter(
      (seat) =>
        seat.ticket_type_id === ticketTypeId &&
        seat.available &&
        !seat.blocked,
    )
    .sort((left, right) =>
      left.row.localeCompare(right.row, undefined, { numeric: true }) ||
      left.number - right.number,
    );
  const rows = new Map<string, SeatData[]>();
  for (const seat of available) {
    rows.set(seat.row, [...(rows.get(seat.row) ?? []), seat]);
  }
  for (const row of rows.values()) {
    for (let start = 0; start <= row.length - quantity; start += 1) {
      const group = row.slice(start, start + quantity);
      if (group.every((seat, index) => index === 0 || seat.number === group[index - 1]!.number + 1)) {
        return group;
      }
    }
  }
  return available.slice(0, quantity);
}
