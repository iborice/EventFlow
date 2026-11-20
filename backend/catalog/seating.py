from django.db.models import Q
from django.utils import timezone

from .models import (
    Event,
    Order,
    Seat,
    SeatMap,
    SeatReservation,
    TicketType,
)


class SeatSelectionError(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def release_expired_seat_reservations(seat_ids=None, *, at=None) -> int:
    now = at or timezone.now()
    reservations = SeatReservation.objects.filter(
        status=SeatReservation.Status.HELD,
    ).filter(
        Q(order_item__order__status__in=[Order.Status.EXPIRED, Order.Status.CANCELLED])
        | Q(
            order_item__order__status=Order.Status.PENDING,
            order_item__order__expires_at__lte=now,
        )
    )
    if seat_ids is not None:
        reservations = reservations.filter(seat_id__in=seat_ids)
    return reservations.update(status=SeatReservation.Status.RELEASED)


def select_available_seats(
    ticket: TicketType,
    seat_ids: list[int],
    quantity: int,
    *,
    at=None,
) -> list[Seat]:
    seat_map = seat_map_for_ticket(ticket)
    if seat_map and len(seat_ids) != quantity:
        raise SeatSelectionError("Choose one available seat for each ticket.", 400)
    if seat_ids and seat_map is None:
        raise SeatSelectionError(
            "The selected ticket does not use reserved seating.",
            400,
        )
    if seat_map is None:
        return []

    release_expired_seat_reservations(seat_ids, at=at)
    selected_seats = list(
        Seat.objects.select_for_update()
        .filter(
            seat_map=seat_map,
            zone__ticket_type=ticket,
            blocked=False,
            pk__in=seat_ids,
        )
        .order_by("pk")
    )
    if len(selected_seats) != quantity:
        raise SeatSelectionError(
            "One or more selected seats are no longer available.",
            409,
        )
    if SeatReservation.objects.filter(
        seat_id__in=seat_ids,
        status__in=[
            SeatReservation.Status.HELD,
            SeatReservation.Status.CONFIRMED,
        ],
    ).exists():
        raise SeatSelectionError(
            "One or more selected seats are no longer available.",
            409,
        )
    return selected_seats


def public_seat_map(event: Event) -> dict[str, object] | None:
    seat_map = (
        SeatMap.objects.filter(event=event)
        .prefetch_related("zones__ticket_type", "seats__zone__ticket_type")
        .first()
    )
    if seat_map is None:
        return None

    occupied_ids = set(
        SeatReservation.objects.filter(
            seat__seat_map=seat_map,
        )
        .filter(
            Q(status=SeatReservation.Status.CONFIRMED)
            | Q(
                status=SeatReservation.Status.HELD,
                order_item__order__status=Order.Status.PENDING,
                order_item__order__expires_at__gt=timezone.now(),
            )
        )
        .values_list("seat_id", flat=True)
    )
    return {
        "width": seat_map.width,
        "height": seat_map.height,
        "zones": [
            {
                "key": zone.key,
                "name": zone.name,
                "color": zone.color,
                "ticket_type_id": zone.ticket_type_id,
                "ticket_name": zone.ticket_type.name,
                "price": str(zone.ticket_type.price),
            }
            for zone in seat_map.zones.all()
        ],
        "seats": [
            {
                "id": seat.pk,
                "label": seat.label,
                "row": seat.row_label,
                "number": seat.seat_number,
                "x": seat.x,
                "y": seat.y,
                "zone_key": seat.zone.key,
                "zone_color": seat.zone.color,
                "ticket_type_id": seat.zone.ticket_type_id,
                "blocked": seat.blocked,
                "available": not seat.blocked and seat.pk not in occupied_ids,
            }
            for seat in seat_map.seats.all()
        ],
    }


def seat_map_for_ticket(ticket: TicketType) -> SeatMap | None:
    return (
        SeatMap.objects.filter(
            event=ticket.event,
            zones__ticket_type=ticket,
        )
        .distinct()
        .first()
    )
