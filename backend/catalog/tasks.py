from celery import shared_task
from django.utils import timezone

from .models import Order, OrderItem, SeatReservation, WaitlistEntry


@shared_task
def expire_reservations_and_offer_waitlist() -> int:
    now = timezone.now()
    expired_ticket_ids = set(
        OrderItem.objects.filter(
            order__status=Order.Status.PENDING,
            order__expires_at__lte=now,
        ).values_list("ticket_type_id", flat=True)
    )
    Order.objects.filter(
        status=Order.Status.PENDING,
        expires_at__lte=now,
    ).update(status=Order.Status.EXPIRED)
    SeatReservation.objects.filter(
        status=SeatReservation.Status.HELD,
        order_item__order__status=Order.Status.EXPIRED,
    ).update(status=SeatReservation.Status.RELEASED)

    waiting_ticket_ids = set(
        WaitlistEntry.objects.filter(
            status__in=[
                WaitlistEntry.Status.WAITING,
                WaitlistEntry.Status.OFFERED,
            ]
        ).values_list("ticket_type_id", flat=True)
    )
    from config.api import offer_waitlist_for_ticket

    offered = 0
    for ticket_type_id in expired_ticket_ids | waiting_ticket_ids:
        offered += offer_waitlist_for_ticket(ticket_type_id, now)
    return offered
