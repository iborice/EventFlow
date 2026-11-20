import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.core.cache import cache
from django.test import Client
from django.utils import timezone

from catalog.models import Event, Order, OrderItem, TicketType


@pytest.fixture(autouse=True)
def clear_rate_limit_cache() -> None:
    cache.clear()


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


def reservation_payload(ticket: TicketType, **overrides: object) -> dict[str, object]:
    return {
        "ticket_type_id": ticket.id,
        "quantity": 2,
        "customer_name": " Alex Morgan ",
        "customer_email": " ALEX@EXAMPLE.COM ",
        "idempotency_key": str(uuid.uuid4()),
        **overrides,
    }


def post_reservation(payload: dict[str, object], slug: str = "afterglow"):
    return Client().post(
        f"/api/v1/events/{slug}/reservations",
        data=json.dumps(payload),
        content_type="application/json",
    )


@pytest.mark.django_db
def test_reservation_creates_a_priced_temporary_hold(
    published_event: tuple[Event, TicketType],
) -> None:
    event, ticket = published_event

    response = post_reservation(reservation_payload(ticket))

    assert response.status_code == 201
    body = response.json()
    order = Order.objects.get(id=body["id"])
    item = OrderItem.objects.get(order=order)
    assert body["status"] == Order.Status.PENDING
    assert body["event_slug"] == event.slug
    assert body["ticket_name"] == ticket.name
    assert body["subtotal"] == "39.98"
    assert body["fees"] == "0.00"
    assert body["total"] == "39.98"
    assert order.customer_name == "Alex Morgan"
    assert order.customer_email == "alex@example.com"
    assert item.unit_price == Decimal("19.99")
    assert order.expires_at > timezone.now()
    ticket.refresh_from_db()
    assert ticket.remaining == 8


@pytest.mark.django_db
def test_same_idempotency_key_returns_existing_reservation(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    payload = reservation_payload(ticket)

    first = post_reservation(payload)
    retry = post_reservation(payload)

    assert first.status_code == 201
    assert retry.status_code == 200
    assert retry.json()["id"] == first.json()["id"]
    assert Order.objects.count() == 1
    ticket.refresh_from_db()
    assert ticket.remaining == 8


@pytest.mark.django_db
def test_order_totals_support_maximum_ticket_price_and_quantity(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    ticket.price = Decimal("99999999.99")
    ticket.capacity = 6
    ticket.save(update_fields=["price", "capacity"])

    response = post_reservation(reservation_payload(ticket, quantity=6))

    assert response.status_code == 201
    assert response.json()["total"] == "599999999.94"


@pytest.mark.django_db
def test_idempotency_key_cannot_be_reused_for_a_different_order(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    payload = reservation_payload(ticket)
    assert post_reservation(payload).status_code == 201

    changed_payload = {**payload, "quantity": 1}
    response = post_reservation(changed_payload)

    assert response.status_code == 409
    assert Order.objects.count() == 1


@pytest.mark.django_db
def test_active_holds_reduce_available_inventory(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    ticket.sold = 8
    ticket.save(update_fields=["sold"])

    first = post_reservation(reservation_payload(ticket))
    catalog = Client().get("/api/v1/events")
    second = post_reservation(reservation_payload(ticket, quantity=1))

    assert first.status_code == 201
    assert catalog.json()[0]["tickets"][0]["remaining"] == 0
    assert second.status_code == 409
    ticket.refresh_from_db()
    assert ticket.remaining == 0


@pytest.mark.django_db
def test_expired_reservations_release_inventory_and_report_expired_status(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    payload = reservation_payload(ticket)
    first = post_reservation(payload)
    order = Order.objects.get(id=first.json()["id"])
    order.expires_at = timezone.now() - timedelta(seconds=1)
    order.save(update_fields=["expires_at"])

    retry = post_reservation(payload)
    replacement = post_reservation(reservation_payload(ticket))
    catalog = Client().get("/api/v1/events")

    assert retry.status_code == 200
    assert retry.json()["status"] == Order.Status.EXPIRED
    assert replacement.status_code == 201
    assert catalog.json()[0]["tickets"][0]["remaining"] == 8


@pytest.mark.django_db
def test_reservations_require_a_published_event_and_active_ticket(
    published_event: tuple[Event, TicketType],
) -> None:
    event, ticket = published_event
    draft = Event.objects.create(
        title="Draft",
        slug="draft",
        starts_at=timezone.now() + timedelta(days=30),
        venue="Secret room",
    )
    inactive_ticket = TicketType.objects.create(
        event=event,
        name="Inactive",
        price=Decimal("10.00"),
        capacity=5,
        active=False,
    )

    assert post_reservation(reservation_payload(ticket), slug=draft.slug).status_code == 404
    assert post_reservation(
        reservation_payload(inactive_ticket)
    ).status_code == 404


@pytest.mark.django_db
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("quantity", 0),
        ("quantity", 7),
        ("customer_email", "not-an-email"),
        ("customer_name", " "),
    ],
)
def test_reservation_input_is_validated(
    published_event: tuple[Event, TicketType],
    field: str,
    value: object,
) -> None:
    _, ticket = published_event
    payload = reservation_payload(ticket, **{field: value})

    response = post_reservation(payload)

    assert response.status_code == 422
    assert Order.objects.count() == 0


@pytest.mark.django_db
def test_reservation_endpoint_limits_requests_per_client_ip(
    published_event: tuple[Event, TicketType],
) -> None:
    _, ticket = published_event
    ticket.capacity = 100
    ticket.save(update_fields=["capacity"])
    responses = [
        post_reservation(reservation_payload(ticket))
        for _ in range(21)
    ]

    assert [response.status_code for response in responses[:20]] == [201] * 20
    assert responses[20].status_code == 429
