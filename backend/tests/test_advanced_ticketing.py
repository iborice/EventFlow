import json
import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from catalog.models import (
    Event,
    Organization,
    OrganizationMembership,
    Order,
    OrderItem,
    PromotionCode,
    RecurringEventSeries,
    TicketPriceTier,
    TicketType,
    WaitlistEntry,
)
from catalog.tasks import expire_reservations_and_offer_waitlist


def signed_in_client(email: str = "admin@example.com") -> Client:
    user = get_user_model().objects.create_user(
        username=email,
        email=email,
        password="SecurePass123!",
    )
    client = Client()
    client.force_login(user)
    return client


def json_request(client: Client, method: str, path: str, payload: dict[str, object]):
    csrf = client.get("/api/v1/auth/csrf")
    assert csrf.status_code == 200
    return getattr(client, method)(
        path,
        data=json.dumps(payload),
        content_type="application/json",
        HTTP_X_CSRFTOKEN=csrf.json()["csrf_token"],
    )


def create_workspace(client: Client) -> Organization:
    user = get_user_model().objects.get(email="admin@example.com")
    organization = Organization.objects.create(
        name="North Studio",
        created_by=user,
    )
    OrganizationMembership.objects.create(
        organization=organization,
        user=user,
        role=OrganizationMembership.Role.ADMIN,
    )
    return organization


def recurring_payload(occurrences: list[dict[str, object]]) -> dict[str, object]:
    return {
        "title": "Community Night",
        "description": "A recurring event.",
        "venue": "Pier 27",
        "ticket_name": "Admission",
        "status": "published",
        "occurrences": occurrences,
    }


@pytest.mark.django_db
def test_recurring_series_creates_custom_occurrences_and_price_tiers() -> None:
    client = signed_in_client()
    organization = create_workspace(client)
    start = timezone.now() + timedelta(days=30)
    payload = recurring_payload(
        [
            {
                "starts_at": start.isoformat(),
                "price": "25.00",
                "capacity": 10,
                "price_tiers": [
                    {"name": "Early", "price": "15.00", "capacity": 4},
                    {"name": "Regular", "price": "25.00", "capacity": 6},
                ],
            },
            {
                "starts_at": (start + timedelta(days=7)).isoformat(),
                "price": "30.00",
                "capacity": 20,
            },
        ]
    )

    response = json_request(
        client,
        "post",
        f"/api/v1/organizations/{organization.slug}/recurring-events",
        payload,
    )

    assert response.status_code == 200
    body = response.json()
    series = RecurringEventSeries.objects.get(pk=body["id"])
    events = list(series.events.order_by("starts_at"))
    assert len(events) == 2
    assert events[0].ticket_types.get().capacity == 10
    assert events[0].ticket_types.get().price_tiers.count() == 2
    assert events[1].ticket_types.get().price == Decimal("30.00")
    assert len(body["events"]) == 2
    catalog = client.get("/api/v1/events").json()
    assert all(not event["series_dates"] for event in catalog)
    public_event = client.get(f"/api/v1/events/{events[0].slug}")
    assert len(public_event.json()["series_dates"]) == 2


@pytest.mark.django_db
def test_recurring_series_rejects_more_than_1200_dates_atomically() -> None:
    client = signed_in_client()
    organization = create_workspace(client)
    start = timezone.now() + timedelta(days=30)
    payload = recurring_payload(
        [
            {
                "starts_at": (start + timedelta(minutes=index)).isoformat(),
                "price": "25.00",
                "capacity": 10,
            }
            for index in range(1201)
        ]
    )

    response = json_request(
        client,
        "post",
        f"/api/v1/organizations/{organization.slug}/recurring-events",
        payload,
    )

    assert response.status_code == 422
    assert not RecurringEventSeries.objects.exists()
    assert not Event.objects.exists()


@pytest.mark.django_db
def test_price_tiers_advance_and_promotions_reveal_hidden_tickets() -> None:
    client = signed_in_client()
    organization = create_workspace(client)
    starts_at = (timezone.now() + timedelta(days=30)).isoformat()
    created = json_request(
        client,
        "post",
        f"/api/v1/organizations/{organization.slug}/events",
        {
            "title": "Tiered Night",
            "description": "",
            "starts_at": starts_at,
            "venue": "Pier 27",
            "ticket_name": "Admission",
            "ticket_description": "",
            "price": "30.00",
            "capacity": 3,
            "status": "published",
            "price_tiers": [
                {"name": "Early", "price": "10.00", "capacity": 1},
                {"name": "Regular", "price": "30.00", "capacity": 2},
            ],
        },
    )
    assert created.status_code == 200
    event = Event.objects.get(pk=created.json()["id"])
    ticket = event.ticket_types.get()
    early, regular = ticket.price_tiers.order_by("position")
    hidden_ticket = TicketType.objects.create(
        event=event,
        name="Secret table",
        price=Decimal("90.00"),
        capacity=2,
        hidden=True,
    )
    promo_response = json_request(
        client,
        "post",
        f"/api/v1/organizations/{organization.slug}/events/{event.id}/promotions",
        {
            "code": "SAVE10",
            "discount_type": "percent",
            "value": "10",
            "max_uses": 1,
            "reveals_hidden_tickets": True,
        },
    )
    assert promo_response.status_code == 200

    public_event = client.get(f"/api/v1/events/{event.slug}").json()
    assert [item["id"] for item in public_event["tickets"]] == [ticket.id]
    assert public_event["tickets"][0]["price_tiers"][0]["id"] == early.id
    preview = json_request(
        client,
        "post",
        f"/api/v1/events/{event.slug}/promotions/validate",
        {
            "code": "save10",
            "ticket_type_id": ticket.id,
            "price_tier_id": early.id,
            "quantity": 1,
        },
    )
    assert preview.status_code == 200
    assert preview.json()["discount_amount"] == "1.00"
    assert preview.json()["revealed_tickets"][0]["id"] == hidden_ticket.id

    first_order = json_request(
        client,
        "post",
        f"/api/v1/events/{event.slug}/reservations",
        {
            "ticket_type_id": ticket.id,
            "quantity": 1,
            "customer_name": "Alex Morgan",
            "customer_email": "alex@example.com",
            "idempotency_key": str(uuid.uuid4()),
        },
    )
    assert first_order.status_code == 201
    assert first_order.json()["price_tier_id"] == early.id
    assert first_order.json()["total"] == "10.00"

    second_order = json_request(
        client,
        "post",
        f"/api/v1/events/{event.slug}/reservations",
        {
            "ticket_type_id": ticket.id,
            "quantity": 1,
            "customer_name": "Jamie Chen",
            "customer_email": "jamie@example.com",
            "idempotency_key": str(uuid.uuid4()),
        },
    )
    assert second_order.status_code == 201
    assert second_order.json()["price_tier_id"] == regular.id
    assert second_order.json()["total"] == "30.00"

    hidden_order = json_request(
        client,
        "post",
        f"/api/v1/events/{event.slug}/reservations",
        {
            "ticket_type_id": hidden_ticket.id,
            "quantity": 1,
            "customer_name": "Taylor Reed",
            "customer_email": "taylor@example.com",
            "idempotency_key": str(uuid.uuid4()),
            "promo_code": "SAVE10",
        },
    )
    assert hidden_order.status_code == 201
    assert hidden_order.json()["discount_amount"] == "9.00"
    assert hidden_order.json()["total"] == "81.00"

    exhausted_code = json_request(
        client,
        "post",
        f"/api/v1/events/{event.slug}/reservations",
        {
            "ticket_type_id": ticket.id,
            "quantity": 1,
            "customer_name": "Sam Lee",
            "customer_email": "sam@example.com",
            "idempotency_key": str(uuid.uuid4()),
            "promo_code": "SAVE10",
        },
    )
    assert exhausted_code.status_code == 400


@pytest.mark.django_db
def test_waitlist_offer_is_created_after_expired_inventory_is_released() -> None:
    event = Event.objects.create(
        title="Sold Out Night",
        slug="sold-out-night",
        starts_at=timezone.now() + timedelta(days=30),
        venue="Pier 27",
        status=Event.Status.PUBLISHED,
    )
    ticket = TicketType.objects.create(
        event=event,
        name="Free admission",
        price=Decimal("0.00"),
        capacity=1,
    )
    reservation = json_request(
        Client(),
        "post",
        f"/api/v1/events/{event.slug}/reservations",
        {
            "ticket_type_id": ticket.id,
            "quantity": 1,
            "customer_name": "Alex Morgan",
            "customer_email": "alex@example.com",
            "idempotency_key": str(uuid.uuid4()),
        },
    )
    held_order = Order.objects.get(pk=reservation.json()["id"])
    waitlist = json_request(
        Client(),
        "post",
        f"/api/v1/events/{event.slug}/waitlist",
        {
            "ticket_type_id": ticket.id,
            "quantity": 1,
            "customer_name": "Jamie Chen",
            "customer_email": "jamie@example.com",
        },
    )
    assert reservation.status_code == 201
    assert waitlist.status_code == 200
    assert waitlist.json()["status"] == WaitlistEntry.Status.WAITING

    held_order.expires_at = timezone.now() - timedelta(seconds=1)
    held_order.save(update_fields=["expires_at"])
    assert expire_reservations_and_offer_waitlist.run() == 1

    entry = WaitlistEntry.objects.get(token=waitlist.json()["token"])
    assert entry.status == WaitlistEntry.Status.OFFERED
    assert entry.order is not None
    assert entry.order.total == Decimal("0.00")
    assert ticket.remaining == 0
    checkout = Client().post(
        f"/api/v1/waitlist/{entry.token}/checkout-session"
    )
    entry.refresh_from_db()
    assert checkout.status_code == 200
    assert checkout.json()["checkout_url"].endswith(
        f"/orders/success?order={entry.order_id}"
    )
    assert entry.status == WaitlistEntry.Status.CONVERTED
    assert entry.order.status == Order.Status.CONFIRMED
    assert entry.order.issued_tickets.count() == 1
