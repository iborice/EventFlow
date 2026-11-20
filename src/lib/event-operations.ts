import type { SeatMapData } from "./seating";

export interface SeatingTicketType {
  id: number;
  name: string;
  price: string;
  capacity: number;
  remaining: number;
  hidden: boolean;
  price_tiers: {
    id: number;
    name: string;
    price: string;
    remaining: number;
  }[];
}

export interface SeatingWorkspace extends SeatMapData {
  event_id: number;
  event_title: string;
  configured: boolean;
  ticket_types: SeatingTicketType[];
}

export interface BoxOfficeSale {
  order_id: string;
  status: string;
  event_slug: string;
  ticket_name: string;
  quantity: number;
  payment_method: "cash" | "card" | "comp";
  subtotal: string;
  total: string;
  cash_received: string | null;
  change_due: string;
  seat_labels: string[];
  ticket_ids: string[];
}

export interface CheckInResult {
  ticket_id: string;
  status: "checked_in" | "already_checked_in" | "invalid";
  ticket_name: string | null;
  attendee_name: string | null;
  seat_label: string | null;
  checked_in_at: string | null;
}

export interface CheckInTicket {
  ticket_id: string;
  ticket_name: string;
  attendee_name: string;
  attendee_email: string;
  seat_label: string | null;
  checked_in_at: string | null;
}
