from datetime import timedelta
from decimal import Decimal
from uuid import UUID

import stripe
from django.conf import settings
from django.db import transaction
from django.db.models import F, Sum
from django.utils import timezone

from .models import (
    Event,
    IssuedTicket,
    Order,
    OrderItem,
    PromotionCode,
    SeatReservation,
    TicketPriceTier,
    TicketType,
    WaitlistEntry,
)

CHECKOUT_SESSION_LIFETIME = timedelta(minutes=31)
INVENTORY_RELEASE_GRACE = timedelta(minutes=5)


class OrderNotPayable(Exception):
    pass


class CheckoutSessionUnavailable(Exception):
    pass


class WebhookRetry(Exception):
    pass


def create_checkout_session(order_id: UUID) -> str:
    event_id = Order.objects.filter(pk=order_id).values_list("event_id", flat=True).first()
    if event_id is None:
        raise OrderNotPayable("Order not found.")

    now = timezone.now()
    with transaction.atomic():
        Event.objects.select_for_update().get(pk=event_id)
        order = Order.objects.select_for_update().get(pk=order_id)
        items = list(
            OrderItem.objects.select_related("ticket_type")
            .filter(order=order)
            .order_by("id")
        )
        if order.status == Order.Status.CONFIRMED and order.total == 0:
            return _success_url(order.id)
        if (
            order.status != Order.Status.PENDING
            or order.expires_at <= now
            or (
                order.payment_expires_at is not None
                and order.payment_expires_at <= now
            )
            or not items
        ):
            raise OrderNotPayable("This reservation can no longer be paid.")

        if order.total == 0:
            issue_reserved_tickets(order, items, increment_sold=True)
            _record_promotion_redemption(order)
            order.status = Order.Status.CONFIRMED
            order.save(update_fields=["status"])
            return _success_url(order.id)

        if order.payment_expires_at is None:
            order.payment_expires_at = now + CHECKOUT_SESSION_LIFETIME
            order.expires_at = order.payment_expires_at + INVENTORY_RELEASE_GRACE
            order.save(update_fields=["payment_expires_at", "expires_at"])

        payment_expires_at = order.payment_expires_at
        success_url = _success_url(order.id, include_session=True)
        cancel_url = (
            f"{settings.PUBLIC_SITE_URL}/events/{order.event.slug}/checkout"
            f"?ticket={items[0].ticket_type_id}&payment=cancelled"
        )
        line_items = _stripe_line_items(order, items)

    session = stripe.checkout.Session.create(
        mode="payment",
        payment_method_types=["card"],
        line_items=line_items,
        customer_email=order.customer_email,
        client_reference_id=str(order.id),
        metadata={"order_id": str(order.id)},
        success_url=success_url,
        cancel_url=cancel_url,
        expires_at=int(payment_expires_at.timestamp()),
        idempotency_key=f"eventflow-checkout-{order.id}",
        api_key=settings.STRIPE_SECRET_KEY,
    )
    if not session.url:
        raise CheckoutSessionUnavailable("Stripe did not return a checkout URL.")

    with transaction.atomic():
        Event.objects.select_for_update().get(pk=event_id)
        locked_order = Order.objects.select_for_update().get(pk=order_id)
        if (
            locked_order.payment_session_id
            and locked_order.payment_session_id != session.id
        ):
            raise WebhookRetry("A different Stripe session is already attached.")
        if locked_order.status != Order.Status.PENDING:
            raise OrderNotPayable("This reservation can no longer be paid.")
        locked_order.payment_session_id = session.id
        locked_order.payment_method = Order.PaymentMethod.STRIPE
        locked_order.save(update_fields=["payment_session_id", "payment_method"])

    return session.url


def process_checkout_session(event_type: str, session: stripe.StripeObject) -> None:
    metadata = session.get("metadata") or {}
    try:
        order_id = UUID(str(metadata.get("order_id", "")))
    except ValueError as exc:
        raise WebhookRetry("Stripe session has no valid order reference.") from exc

    if event_type == "checkout.session.expired":
        _expire_order(order_id, str(session.id))
        return
    if event_type != "checkout.session.completed":
        return
    if session.get("payment_status") != "paid":
        return
    _confirm_paid_order(order_id, session)


def _confirm_paid_order(order_id: UUID, session: stripe.StripeObject) -> None:
    event_id = Order.objects.filter(pk=order_id).values_list("event_id", flat=True).first()
    if event_id is None:
        raise WebhookRetry("Order referenced by Stripe does not exist.")

    needs_refund = False
    with transaction.atomic():
        Event.objects.select_for_update().get(pk=event_id)
        order = Order.objects.select_for_update().get(pk=order_id)
        session_id = str(session.id)
        if not order.payment_session_id or order.payment_session_id != session_id:
            raise WebhookRetry("Stripe session is not attached to this order yet.")
        if order.status == Order.Status.CONFIRMED:
            return
        if order.status == Order.Status.REFUND_PENDING:
            needs_refund = True
        elif order.status != Order.Status.PENDING:
            order.status = Order.Status.REFUND_PENDING
            order.save(update_fields=["status"])
            needs_refund = True
        else:
            expected_amount = int(order.total * 100)
            if (
                session.get("currency") != order.currency.lower()
                or session.get("amount_total") != expected_amount
            ):
                raise WebhookRetry("Paid amount does not match the order total.")

            items = list(
                OrderItem.objects.select_related("ticket_type")
                .filter(order=order)
                .order_by("id")
            )
            if not items:
                raise WebhookRetry("Paid order has no ticket items.")

            locked_tickets: list[
                tuple[TicketType, OrderItem, TicketPriceTier | None]
            ] = []
            for item in items:
                ticket_type = TicketType.objects.select_for_update().get(
                    pk=item.ticket_type_id
                )
                other_holds = (
                    OrderItem.objects.filter(
                        ticket_type=ticket_type,
                        order__status=Order.Status.PENDING,
                        order__expires_at__gt=timezone.now(),
                    )
                    .exclude(order_id=order.id)
                    .aggregate(quantity=Sum("quantity"))["quantity"]
                    or 0
                )
                if ticket_type.sold + item.quantity + other_holds > ticket_type.capacity:
                    order.status = Order.Status.REFUND_PENDING
                    order.save(update_fields=["status"])
                    needs_refund = True
                    break
                price_tier = None
                if item.price_tier_id is not None:
                    price_tier = TicketPriceTier.objects.select_for_update().get(
                        pk=item.price_tier_id
                    )
                    tier_holds = (
                        OrderItem.objects.filter(
                            price_tier=price_tier,
                            order__status=Order.Status.PENDING,
                            order__expires_at__gt=timezone.now(),
                        )
                        .exclude(order_id=order.id)
                        .aggregate(quantity=Sum("quantity"))["quantity"]
                        or 0
                    )
                    if price_tier.sold + item.quantity + tier_holds > price_tier.capacity:
                        order.status = Order.Status.REFUND_PENDING
                        order.save(update_fields=["status"])
                        needs_refund = True
                        break
                locked_tickets.append((ticket_type, item, price_tier))

            if not needs_refund:
                for ticket_type, item, price_tier in locked_tickets:
                    ticket_type.sold += item.quantity
                    ticket_type.save(update_fields=["sold"])
                    if price_tier is not None:
                        price_tier.sold += item.quantity
                        price_tier.save(update_fields=["sold"])
                issue_reserved_tickets(order, items)
                _record_promotion_redemption(order)
                order.status = Order.Status.CONFIRMED
                order.save(update_fields=["status"])
                WaitlistEntry.objects.filter(
                    order=order,
                    status=WaitlistEntry.Status.OFFERED,
                ).update(status=WaitlistEntry.Status.CONVERTED)

    if needs_refund:
        payment_intent = session.get("payment_intent")
        if not payment_intent:
            raise WebhookRetry("Paid checkout has no payment intent to refund.")
        payment_intent_id = (
            str(payment_intent)
            if isinstance(payment_intent, str)
            else str(payment_intent.id)
        )
        stripe.Refund.create(
            payment_intent=payment_intent_id,
            metadata={"order_id": str(order_id), "reason": "inventory_unavailable"},
            idempotency_key=f"eventflow-refund-{session.id}",
            api_key=settings.STRIPE_SECRET_KEY,
        )
        Order.objects.filter(
            pk=order_id,
            status=Order.Status.REFUND_PENDING,
        ).update(status=Order.Status.CANCELLED)


def _expire_order(order_id: UUID, session_id: str) -> None:
    event_id = Order.objects.filter(pk=order_id).values_list("event_id", flat=True).first()
    if event_id is None:
        raise WebhookRetry("Order referenced by Stripe does not exist.")
    with transaction.atomic():
        Event.objects.select_for_update().get(pk=event_id)
        order = Order.objects.select_for_update().get(pk=order_id)
        if order.payment_session_id != session_id:
            raise WebhookRetry("Stripe session is not attached to this order yet.")
        if order.status == Order.Status.PENDING:
            order.status = Order.Status.EXPIRED
            order.save(update_fields=["status"])
            WaitlistEntry.objects.filter(
                order=order,
                status=WaitlistEntry.Status.OFFERED,
            ).update(status=WaitlistEntry.Status.EXPIRED)
            SeatReservation.objects.filter(
                order_item__order=order,
                status=SeatReservation.Status.HELD,
            ).update(status=SeatReservation.Status.RELEASED)


def issue_reserved_tickets(
    order: Order,
    items: list[OrderItem],
    *,
    increment_sold: bool = False,
) -> None:
    if increment_sold:
        for item in items:
            ticket_type = TicketType.objects.select_for_update().get(
                pk=item.ticket_type_id
            )
            other_holds = (
                OrderItem.objects.filter(
                    ticket_type=ticket_type,
                    order__status=Order.Status.PENDING,
                    order__expires_at__gt=timezone.now(),
                )
                .exclude(order_id=order.id)
                .aggregate(quantity=Sum("quantity"))["quantity"]
                or 0
            )
            if ticket_type.sold + item.quantity + other_holds > ticket_type.capacity:
                raise OrderNotPayable("Not enough tickets remain to confirm this order.")
            ticket_type.sold += item.quantity
            ticket_type.save(update_fields=["sold"])
            if item.price_tier_id is not None:
                price_tier = TicketPriceTier.objects.select_for_update().get(
                    pk=item.price_tier_id
                )
                tier_holds = (
                    OrderItem.objects.filter(
                        price_tier=price_tier,
                        order__status=Order.Status.PENDING,
                        order__expires_at__gt=timezone.now(),
                    )
                    .exclude(order_id=order.id)
                    .aggregate(quantity=Sum("quantity"))["quantity"]
                    or 0
                )
                if price_tier.sold + item.quantity + tier_holds > price_tier.capacity:
                    raise OrderNotPayable(
                        "Not enough tickets remain at the selected price tier."
                    )
                price_tier.sold += item.quantity
                price_tier.save(update_fields=["sold"])

    issued_tickets = IssuedTicket.objects.bulk_create(
        [
            IssuedTicket(order=order, ticket_type=item.ticket_type)
            for item in items
            for _ in range(item.quantity)
        ]
    )
    seat_reservations = list(
        SeatReservation.objects.select_for_update()
        .filter(
            order_item__in=items,
            status=SeatReservation.Status.HELD,
        )
        .order_by("order_item_id", "seat__row_label", "seat__seat_number")
    )
    if seat_reservations:
        if len(seat_reservations) != len(issued_tickets):
            raise OrderNotPayable("Reserved seat assignments do not match the ticket quantity.")
        for reservation, issued_ticket in zip(seat_reservations, issued_tickets):
            reservation.issued_ticket = issued_ticket
            reservation.status = SeatReservation.Status.CONFIRMED
        SeatReservation.objects.bulk_update(
            seat_reservations,
            ["issued_ticket", "status"],
        )


def _success_url(order_id: UUID, *, include_session: bool = False) -> str:
    url = f"{settings.PUBLIC_SITE_URL}/orders/success?order={order_id}"
    if include_session:
        return f"{url}&session_id={{CHECKOUT_SESSION_ID}}"
    return url


def _record_promotion_redemption(order: Order) -> None:
    if order.promotion_id is not None:
        PromotionCode.objects.filter(pk=order.promotion_id).update(
            used_count=F("used_count") + 1
        )


def _stripe_line_items(
    order: Order,
    items: list[OrderItem],
) -> list[dict[str, object]]:
    unit_prices = [
        (item, int(item.unit_price * 100))
        for item in items
        for _ in range(item.quantity)
    ]
    remaining_discount = int(order.discount_amount * 100)
    remaining_tickets = len(unit_prices)
    grouped_prices: dict[tuple[str, int], int] = {}
    for item, unit_price in unit_prices:
        discount_share = (
            (remaining_discount + remaining_tickets - 1) // remaining_tickets
            if remaining_tickets
            else 0
        )
        discount = min(unit_price, discount_share)
        remaining_discount -= discount
        remaining_tickets -= 1
        key = (item.ticket_type.name, unit_price - discount)
        grouped_prices[key] = grouped_prices.get(key, 0) + 1

    line_items: list[dict[str, object]] = []
    for (ticket_name, unit_amount), quantity in grouped_prices.items():
        if unit_amount > 0:
            line_items.append(
                {
                    "price_data": {
                        "currency": order.currency.lower(),
                        "product_data": {
                            "name": f"{order.event.title} — {ticket_name}"
                        },
                        "unit_amount": unit_amount,
                    },
                    "quantity": quantity,
                }
            )
    if order.fees > 0:
        line_items.append(
            {
                "price_data": {
                    "currency": order.currency.lower(),
                    "product_data": {"name": f"{order.event.title} — Fees"},
                    "unit_amount": int(order.fees * 100),
                },
                "quantity": 1,
            }
        )
    return line_items
