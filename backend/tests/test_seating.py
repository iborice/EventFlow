import json
import uuid
from datetime import timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from django.core.cache import cache
from django.contrib.auth import get_user_model
from django.test import Client, override_settings
from django.utils import timezone

from catalog.models import (
    Event,
    IssuedTicket,
    Organization,
    OrganizationMembership,
    Order,
    OrderItem,
    Seat,
    SeatReservation,
    SeatZone,
    TicketType,
)


class StripeSession(dict):
    @property
    def id(self) -> str:
        return str(self["id"])


@pytest.fixture(autouse=True)
def clear_rate_limit_cache() -> None:
    cache.clear()


def signed_in_client() -> tuple[Client, Organization]:
    user = get_user_model().objects.create_user(
        username="seating-admin@example.com",
        email="seating-admin@example.com",
        password="SecurePass123!",
    )
    organization = Organization.objects.create(
        name="Seating Studio",
        created_by=user,
    )
    OrganizationMembership.objects.create(
        organization=organization,
        user=user,
        role=OrganizationMembership.Role.ADMIN,
    )
    client = Client()
    client.force_login(user)
    return client, organization


def json_request(
    client: Client,
    method: str,
    path: str,
    payload: dict[str, object],
):
    csrf = client.get("/api/v1/auth/csrf")
    assert csrf.status_code == 200
    return getattr(client, method)(
        path,
        data=json.dumps(payload),
        content_type="application/json",
        HTTP_X_CSRFTOKEN=csrf.json()["csrf_token"],
    )


def create_event(organization: Organization) -> tuple[Event, TicketType]:
    event = Event.objects.create(
        title="Seated Showcase",
        slug="seated-showcase",
        organization=organization,
        starts_at=timezone.now() + timedelta(days=30),
        venue="The Hall",
        status=Event.Status.PUBLISHED,
    )
    ticket = TicketType.objects.create(
        event=event,
        name="Orchestra",
        price=Decimal("45.00"),
        capacity=4,
    )
    return event, ticket


def map_payload(ticket: TicketType) -> dict[str, object]:
    return {
        "width": 600,
        "height": 400,
        "zones": [
            {
                "key": "orchestra",
                "name": "Orchestra",
                "color": "#7167E8",
                "ticket_type_id": ticket.id,
            }
        ],
        "seats": [
            {
                "label": f"A-{number:02}",
                "row": "A",
                "number": number,
                "x": 120 + number * 50,
                "y": 120,
                "zone_key": "orchestra",
                "blocked": False,
            }
            for number in range(1, 5)
        ],
    }


def create_seat_map(
    client: Client,
    organization: Organization,
    event: Event,
    ticket: TicketType,
) -> dict[str, object]:
    path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/seating"
    )
    response = json_request(client, "put", path, map_payload(ticket))
    assert response.status_code == 200
    return response.json()


def create_reservation(
    event: Event,
    ticket: TicketType,
    seat_ids: list[int],
    *,
    email: str = "guest@example.com",
    quantity: int | None = None,
) -> tuple[object, object]:
    payload = {
        "ticket_type_id": ticket.id,
        "quantity": quantity or len(seat_ids),
        "seat_ids": seat_ids,
        "customer_name": "Guest Attendee",
        "customer_email": email,
        "idempotency_key": str(uuid.uuid4()),
    }
    response = Client().post(
        f"/api/v1/events/{event.slug}/reservations",
        data=json.dumps(payload),
        content_type="application/json",
    )
    return response, payload


@pytest.mark.django_db
def test_seat_map_is_saved_and_public_availability_is_reserved_atomically() -> None:
    client, organization = signed_in_client()
    event, ticket = create_event(organization)
    hidden_ticket = TicketType.objects.create(
        event=event,
        name="Surprise",
        price=Decimal("25.00"),
        capacity=2,
        hidden=True,
    )
    workspace = create_seat_map(client, organization, event, ticket)
    seats = list(Seat.objects.filter(seat_map__event=event).order_by("id"))

    assert workspace["configured"] is True
    assert len(workspace["seats"]) == 4
    workspace_tickets = {item["id"]: item for item in workspace["ticket_types"]}
    assert workspace_tickets[ticket.id]["remaining"] == 4
    assert workspace_tickets[ticket.id]["hidden"] is False
    assert workspace_tickets[hidden_ticket.id]["hidden"] is True
    public_map = Client().get(f"/api/v1/events/{event.slug}/seating").json()
    assert all(seat["available"] for seat in public_map["seats"])

    first, payload = create_reservation(event, ticket, [seats[0].id, seats[1].id])
    assert first.status_code == 201
    assert first.json()["seat_labels"] == ["A-01", "A-02"]
    refreshed_workspace = client.get(
        f"/api/v1/organizations/{organization.slug}/events/{event.id}/seating"
    )
    refreshed_tickets = {
        item["id"]: item for item in refreshed_workspace.json()["ticket_types"]
    }
    assert refreshed_tickets[ticket.id]["remaining"] == 2

    duplicate = Client().post(
        f"/api/v1/events/{event.slug}/reservations",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert duplicate.status_code == 200
    conflict, _ = create_reservation(
        event,
        ticket,
        [seats[0].id],
        email="other@example.com",
    )
    assert conflict.status_code == 409
    no_seat, _ = create_reservation(
        event,
        ticket,
        [],
        email="no-seat@example.com",
        quantity=1,
    )
    assert no_seat.status_code == 400

    held_order = Order.objects.get(pk=first.json()["id"])
    held_order.expires_at = timezone.now() - timedelta(seconds=1)
    held_order.save(update_fields=["expires_at"])
    from catalog.tasks import expire_reservations_and_offer_waitlist

    expire_reservations_and_offer_waitlist.run()
    assert SeatReservation.objects.filter(
        order_item__order=held_order,
        status=SeatReservation.Status.RELEASED,
    ).count() == 2
    public_map = Client().get(f"/api/v1/events/{event.slug}/seating").json()
    assert public_map["seats"][0]["available"] is True


@pytest.mark.django_db
def test_box_office_cash_change_comps_and_checkin_are_idempotent() -> None:
    client, organization = signed_in_client()
    event, ticket = create_event(organization)
    workspace = create_seat_map(client, organization, event, ticket)
    seat_ids = [seat["id"] for seat in workspace["seats"]]
    sale_path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/box-office/orders"
    )
    cash_payload = {
        "ticket_type_id": ticket.id,
        "quantity": 1,
        "customer_name": "Walk-up Guest",
        "payment_method": "cash",
        "cash_received": "50.00",
        "seat_ids": [seat_ids[0]],
        "idempotency_key": str(uuid.uuid4()),
    }

    cash_sale = json_request(client, "post", sale_path, cash_payload)
    duplicate_sale = json_request(client, "post", sale_path, cash_payload)
    assert cash_sale.status_code == 200
    assert cash_sale.json()["change_due"] == "5.00"
    assert cash_sale.json()["seat_labels"] == ["A-01"]
    assert duplicate_sale.json()["order_id"] == cash_sale.json()["order_id"]

    comp_payload = {
        "ticket_type_id": ticket.id,
        "quantity": 1,
        "customer_name": "Guest of the Artist",
        "payment_method": "comp",
        "seat_ids": [seat_ids[1]],
        "idempotency_key": str(uuid.uuid4()),
    }
    comp_sale = json_request(client, "post", sale_path, comp_payload)
    assert comp_sale.status_code == 200
    assert comp_sale.json()["total"] == "0.00"
    assert comp_sale.json()["payment_method"] == "comp"

    ticket.refresh_from_db()
    assert ticket.sold == 2
    check_in_path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/check-in/sync"
    )
    ticket_id = cash_sale.json()["ticket_ids"][0]
    first_scan = json_request(
        client,
        "post",
        check_in_path,
        {"ticket_ids": [ticket_id]},
    )
    repeat_scan = json_request(
        client,
        "post",
        check_in_path,
        {"ticket_ids": [ticket_id]},
    )
    assert first_scan.json()["results"][0]["status"] == "checked_in"
    assert first_scan.json()["results"][0]["seat_label"] == "A-01"
    assert repeat_scan.json()["results"][0]["status"] == "already_checked_in"

    search_path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/check-in/search"
    )
    search = client.get(search_path, {"q": "Walk-up"})
    assert search.status_code == 200
    assert search.json()["total"] == 1
    assert search.json()["tickets"][0]["checked_in_at"] is not None


@pytest.mark.django_db
def test_seat_map_rejects_bad_capacity_and_cannot_change_after_ticket_sales() -> None:
    client, organization = signed_in_client()
    event, ticket = create_event(organization)
    path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/seating"
    )
    invalid = map_payload(ticket)
    invalid["seats"] = invalid["seats"][:-1]
    response = json_request(client, "put", path, invalid)
    assert response.status_code == 400
    assert not SeatZone.objects.exists()

    workspace = create_seat_map(client, organization, event, ticket)
    sale_path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/box-office/orders"
    )
    sale = json_request(
        client,
        "post",
        sale_path,
        {
            "ticket_type_id": ticket.id,
            "quantity": 1,
            "payment_method": "card",
            "seat_ids": [workspace["seats"][0]["id"]],
            "idempotency_key": str(uuid.uuid4()),
        },
    )
    assert sale.status_code == 200
    edit = json_request(client, "put", path, map_payload(ticket))
    assert edit.status_code == 409


@pytest.mark.django_db
@override_settings(STRIPE_WEBHOOK_SECRET="whsec_seating")
def test_paid_reserved_seat_is_assigned_to_ticket_after_stripe_webhook() -> None:
    client, organization = signed_in_client()
    event, ticket = create_event(organization)
    workspace = create_seat_map(client, organization, event, ticket)
    ticket_id = workspace["seats"][0]["id"]
    reservation, _ = create_reservation(event, ticket, [ticket_id])
    order = Order.objects.get(pk=reservation.json()["id"])
    order.payment_session_id = "cs_test_seat"
    order.save(update_fields=["payment_session_id"])
    session = StripeSession(
        {
            "id": "cs_test_seat",
            "metadata": {"order_id": str(order.id)},
            "payment_status": "paid",
            "amount_total": 4500,
            "currency": "usd",
            "payment_intent": "pi_test_seat",
        }
    )
    webhook_event = SimpleNamespace(
        type="checkout.session.completed",
        data=SimpleNamespace(object=session),
    )
    with patch(
        "config.api.stripe.Webhook.construct_event",
        return_value=webhook_event,
    ):
        response = Client().post(
            "/api/v1/payments/stripe/webhook",
            data=b"{}",
            content_type="application/json",
            HTTP_STRIPE_SIGNATURE="test-signature",
        )

    issued_ticket = IssuedTicket.objects.get(order=order)
    assignment = SeatReservation.objects.get(issued_ticket=issued_ticket)
    assert response.status_code == 200
    assert assignment.status == SeatReservation.Status.CONFIRMED
    assert assignment.seat.label == "A-01"
