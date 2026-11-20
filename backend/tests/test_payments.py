import json
import uuid
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.test import Client, override_settings
from django.utils import timezone

from catalog.models import (
    Event,
    IssuedTicket,
    Order,
    OrderItem,
    PromotionCode,
    TicketType,
    WaitlistEntry,
)


@pytest.fixture
def published_event(db: None) -> tuple[Event, TicketType]:
    event = Event.objects.create(
        title="Afterglow",
        slug="afterglow",
        starts_at=timezone.now() + timedelta(days=30),
        venue="Pier 27",
        status=Event.Status.PUBLISHED,
    )
    ticket = TicketType.objects.create(
        event=event,
        name="General",
        price=Decimal("19.99"),
        capacity=10,
    )
    return event, ticket


class StripeSession(dict):
    @property
    def id(self) -> str:
        return str(self["id"])


def create_order(ticket: TicketType, quantity: int = 2) -> Order:
    response = Client().post(
        f"/api/v1/events/{ticket.event.slug}/reservations",
        data=json.dumps(
            {
                "ticket_type_id": ticket.id,
                "quantity": quantity,
                "customer_name": "Alex Morgan",
                "customer_email": "alex@example.com",
                "idempotency_key": str(uuid.uuid4()),
            }
        ),
        content_type="application/json",
    )
    assert response.status_code == 201
    return Order.objects.get(pk=response.json()["id"])


def post_webhook(event_type: str, session: StripeSession):
    event = SimpleNamespace(
        type=event_type,
        data=SimpleNamespace(object=session),
    )
    with patch("config.api.stripe.Webhook.construct_event", return_value=event):
        return Client().post(
            "/api/v1/payments/stripe/webhook",
            data=b"{}",
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE="test-signature",
        )


@pytest.mark.django_db
@override_settings(STRIPE_SECRET_KEY="")
def test_paid_checkout_requires_stripe_configuration(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    order = create_order(ticket)

    response = Client().post(f"/api/v1/orders/{order.id}/checkout-session")

    assert response.status_code == 503
    order.refresh_from_db()
    assert order.payment_session_id is None


@pytest.mark.django_db
@override_settings(STRIPE_SECRET_KEY="sk_test_eventflow")
def test_paid_checkout_creates_a_stripe_session_and_extends_inventory_hold(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    order = create_order(ticket)
    now = timezone.now()
    session = SimpleNamespace(
        id="cs_test_eventflow",
        url="https://checkout.stripe.com/c/pay/test_session",
    )

    with patch(
        "catalog.payments.stripe.checkout.Session.create",
        return_value=session,
    ) as create_session:
        response = Client().post(
            f"/api/v1/orders/{order.id}/checkout-session"
        )

    assert response.status_code == 200
    assert response.json()["checkout_url"] == session.url
    order.refresh_from_db()
    assert order.payment_session_id == session.id
    assert order.payment_expires_at > now + timedelta(minutes=30)
    assert order.expires_at > order.payment_expires_at
    assert create_session.call_args.kwargs["idempotency_key"] == (
        f"eventflow-checkout-{order.id}"
    )
    ticket.refresh_from_db()
    assert ticket.remaining == 8


@pytest.mark.django_db
@override_settings(
    STRIPE_SECRET_KEY="sk_test_eventflow",
    STRIPE_WEBHOOK_SECRET="whsec_eventflow",
)
def test_discounted_stripe_total_matches_order_and_redemption_is_recorded(
    published_event: tuple[Event, TicketType],
) -> None:
    event, ticket = published_event
    promotion = PromotionCode.objects.create(
        event=event,
        code="TAKE10",
        discount_type=PromotionCode.DiscountType.PERCENT,
        value=Decimal("10.00"),
        max_uses=1,
    )
    reservation = Client().post(
        f"/api/v1/events/{event.slug}/reservations",
        data=json.dumps(
            {
                "ticket_type_id": ticket.id,
                "quantity": 2,
                "customer_name": "Alex Morgan",
                "customer_email": "alex@example.com",
                "idempotency_key": str(uuid.uuid4()),
                "promo_code": promotion.code,
            }
        ),
        content_type="application/json",
    )
    assert reservation.status_code == 201
    order = Order.objects.get(pk=reservation.json()["id"])
    assert order.discount_amount == Decimal("4.00")
    session = SimpleNamespace(
        id="cs_test_discounted",
        url="https://checkout.stripe.com/c/pay/discounted",
    )

    with patch(
        "catalog.payments.stripe.checkout.Session.create",
        return_value=session,
    ) as create_session:
        checkout = Client().post(f"/api/v1/orders/{order.id}/checkout-session")

    line_items = create_session.call_args.kwargs["line_items"]
    stripe_total = sum(
        item["price_data"]["unit_amount"] * item["quantity"]
        for item in line_items
    )
    assert checkout.status_code == 200
    assert stripe_total == int(order.total * 100)

    order.refresh_from_db()
    order.payment_session_id = session.id
    order.save(update_fields=["payment_session_id"])
    paid_session = StripeSession(
        id=session.id,
        metadata={"order_id": str(order.id)},
        payment_status="paid",
        amount_total=stripe_total,
        currency="usd",
        payment_intent="pi_test_discounted",
    )
    webhook = post_webhook("checkout.session.completed", paid_session)

    assert webhook.status_code == 200
    promotion.refresh_from_db()
    ticket.refresh_from_db()
    assert promotion.used_count == 1
    assert ticket.sold == 2


@pytest.mark.django_db
@override_settings(STRIPE_SECRET_KEY="")
def test_fully_discounted_paid_ticket_confirms_without_stripe(
    published_event: tuple[Event, TicketType],
) -> None:
    event, ticket = published_event
    promotion = PromotionCode.objects.create(
        event=event,
        code="FREE100",
        discount_type=PromotionCode.DiscountType.PERCENT,
        value=Decimal("100.00"),
    )
    reservation = Client().post(
        f"/api/v1/events/{event.slug}/reservations",
        data=json.dumps(
            {
                "ticket_type_id": ticket.id,
                "quantity": 1,
                "customer_name": "Alex Morgan",
                "customer_email": "alex@example.com",
                "idempotency_key": str(uuid.uuid4()),
                "promo_code": promotion.code,
            }
        ),
        content_type="application/json",
    )
    order = Order.objects.get(pk=reservation.json()["id"])

    checkout = Client().post(f"/api/v1/orders/{order.id}/checkout-session")

    order.refresh_from_db()
    promotion.refresh_from_db()
    assert reservation.status_code == 201
    assert order.total == Decimal("0.00")
    assert checkout.status_code == 200
    assert order.status == Order.Status.CONFIRMED
    assert IssuedTicket.objects.filter(order=order).count() == 1
    assert promotion.used_count == 1


@pytest.mark.django_db
@override_settings(
    STRIPE_SECRET_KEY="sk_test_eventflow",
    STRIPE_WEBHOOK_SECRET="whsec_eventflow",
)
def test_paid_waitlist_offer_stays_open_until_payment_is_confirmed(
    published_event: tuple[Event, TicketType],
) -> None:
    event, ticket = published_event
    now = timezone.now()
    order = Order.objects.create(
        event=event,
        customer_name="Jamie Chen",
        customer_email="jamie@example.com",
        idempotency_key=uuid.uuid4(),
        currency="USD",
        subtotal=ticket.price,
        discount_amount=Decimal("0.00"),
        fees=Decimal("0.00"),
        total=ticket.price,
        expires_at=now + timedelta(minutes=15),
    )
    OrderItem.objects.create(
        order=order,
        ticket_type=ticket,
        quantity=1,
        unit_price=ticket.price,
    )
    entry = WaitlistEntry.objects.create(
        event=event,
        ticket_type=ticket,
        customer_name=order.customer_name,
        customer_email=order.customer_email,
        quantity=1,
        status=WaitlistEntry.Status.OFFERED,
        offer_expires_at=now + timedelta(minutes=15),
        order=order,
    )
    stripe_session = SimpleNamespace(
        id="cs_test_waitlist",
        url="https://checkout.stripe.com/c/pay/waitlist",
    )

    with patch(
        "catalog.payments.stripe.checkout.Session.create",
        return_value=stripe_session,
    ):
        response = Client().post(
            f"/api/v1/waitlist/{entry.token}/checkout-session"
        )

    entry.refresh_from_db()
    order.refresh_from_db()
    assert response.status_code == 200
    assert entry.status == WaitlistEntry.Status.OFFERED
    assert entry.offer_expires_at == order.expires_at
    assert order.payment_session_id == stripe_session.id

    paid_session = StripeSession(
        id=stripe_session.id,
        metadata={"order_id": str(order.id)},
        payment_status="paid",
        amount_total=int(order.total * 100),
        currency="usd",
        payment_intent="pi_test_waitlist",
    )
    webhook = post_webhook("checkout.session.completed", paid_session)

    entry.refresh_from_db()
    assert webhook.status_code == 200
    assert entry.status == WaitlistEntry.Status.CONVERTED


@pytest.mark.django_db
@override_settings(STRIPE_SECRET_KEY="")
def test_free_order_is_confirmed_and_issues_a_pdf_ticket(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    ticket.price = Decimal("0.00")
    ticket.save(update_fields=["price"])
    order = create_order(ticket, quantity=1)

    checkout = Client().post(f"/api/v1/orders/{order.id}/checkout-session")
    order.refresh_from_db()
    issued_ticket = IssuedTicket.objects.get(order=order)
    pdf = Client().get(f"/api/v1/tickets/{issued_ticket.id}/pdf")

    assert checkout.status_code == 200
    assert checkout.json()["checkout_url"].endswith(
        f"/orders/success?order={order.id}"
    )
    assert order.status == Order.Status.CONFIRMED
    assert pdf.status_code == 200
    assert pdf["Content-Type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF")
    ticket.refresh_from_db()
    assert ticket.sold == 1


@pytest.mark.django_db
@override_settings(
    STRIPE_SECRET_KEY="sk_test_eventflow",
    STRIPE_WEBHOOK_SECRET="whsec_eventflow",
)
def test_paid_webhook_confirms_order_and_issues_tickets_idempotently(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    order = create_order(ticket)
    order.payment_session_id = "cs_test_eventflow"
    order.save(update_fields=["payment_session_id"])
    session = StripeSession(
        id="cs_test_eventflow",
        metadata={"order_id": str(order.id)},
        payment_status="paid",
        amount_total=3998,
        currency="usd",
        payment_intent="pi_test_eventflow",
    )

    first = post_webhook("checkout.session.completed", session)
    duplicate = post_webhook("checkout.session.completed", session)

    assert first.status_code == 200
    assert duplicate.status_code == 200
    order.refresh_from_db()
    ticket.refresh_from_db()
    assert order.status == Order.Status.CONFIRMED
    assert ticket.sold == 2
    assert IssuedTicket.objects.filter(order=order).count() == 2


@pytest.mark.django_db
@override_settings(
    STRIPE_SECRET_KEY="sk_test_eventflow",
    STRIPE_WEBHOOK_SECRET="whsec_eventflow",
)
def test_expired_webhook_releases_the_reservation(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    order = create_order(ticket)
    order.payment_session_id = "cs_test_eventflow"
    order.save(update_fields=["payment_session_id"])
    session = StripeSession(
        id="cs_test_eventflow",
        metadata={"order_id": str(order.id)},
    )

    response = post_webhook("checkout.session.expired", session)

    assert response.status_code == 200
    order.refresh_from_db()
    ticket.refresh_from_db()
    assert order.status == Order.Status.EXPIRED
    assert ticket.remaining == 10


@pytest.mark.django_db
@override_settings(
    STRIPE_SECRET_KEY="sk_test_eventflow",
    STRIPE_WEBHOOK_SECRET="whsec_eventflow",
)
def test_paid_order_that_lost_inventory_is_refunded(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    ticket.capacity = 2
    ticket.save(update_fields=["capacity"])
    order = create_order(ticket)
    order.expires_at = timezone.now() - timedelta(seconds=1)
    order.payment_session_id = "cs_test_eventflow"
    order.save(update_fields=["expires_at", "payment_session_id"])
    ticket.sold = 2
    ticket.save(update_fields=["sold"])
    session = StripeSession(
        id="cs_test_eventflow",
        metadata={"order_id": str(order.id)},
        payment_status="paid",
        amount_total=3998,
        currency="usd",
        payment_intent="pi_test_eventflow",
    )

    with patch("catalog.payments.stripe.Refund.create") as create_refund:
        response = post_webhook("checkout.session.completed", session)

    assert response.status_code == 200
    assert create_refund.call_args.kwargs["idempotency_key"] == (
        f"eventflow-refund-{session.id}"
    )
    order.refresh_from_db()
    assert order.status == Order.Status.CANCELLED
    assert not IssuedTicket.objects.filter(order=order).exists()


@pytest.mark.django_db
@override_settings(STRIPE_WEBHOOK_SECRET="whsec_eventflow")
def test_webhook_rejects_malformed_payload() -> None:
    response = Client().post(
        "/api/v1/payments/stripe/webhook",
        data=b"not-json",
        content_type="application/json",
        HTTP_STRIPE_SIGNATURE="invalid",
    )

    assert response.status_code == 400
