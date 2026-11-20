from datetime import timedelta

import pytest
from django.test import Client
from django.utils import timezone

from catalog.models import Event, TicketType


def test_health_endpoint_returns_service_status() -> None:
    response = Client().get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "eventflow-api"}


def test_openapi_schema_is_available() -> None:
    response = Client().get("/api/v1/openapi.json")

    assert response.status_code == 200
    assert response.json()["info"]["title"] == "EventFlow API"


@pytest.mark.django_db
def test_events_endpoint_only_returns_published_events_and_active_tickets() -> None:
    published = Event.objects.create(
        title="Afterglow",
        slug="afterglow",
        description="Live music by the pier.",
        starts_at=timezone.now() + timedelta(days=30),
        venue="Pier 27",
        status=Event.Status.PUBLISHED,
    )
    draft = Event.objects.create(
        title="Private draft",
        slug="private-draft",
        starts_at=timezone.now() + timedelta(days=60),
        venue="Secret venue",
    )
    TicketType.objects.create(
        event=published,
        name="General",
        price="35.00",
        capacity=100,
        sold=22,
    )
    TicketType.objects.create(
        event=published,
        name="Hidden",
        price="60.00",
        capacity=10,
        active=False,
    )
    TicketType.objects.create(
        event=draft,
        name="Draft ticket",
        price="10.00",
        capacity=20,
    )

    response = Client().get("/api/v1/events")

    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["slug"] == "afterglow"
    assert response.json()[0]["tickets"][0]["remaining"] == 78
    assert len(response.json()[0]["tickets"]) == 1


@pytest.mark.django_db
def test_public_event_endpoint_returns_published_event() -> None:
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
        price="35.00",
        capacity=100,
        sold=22,
    )

    response = Client().get("/api/v1/events/afterglow")

    assert response.status_code == 200
    assert response.json()["tickets"] == [
        {
            "id": ticket.id,
            "name": "General",
            "description": "",
            "price": "35.00",
            "capacity": 100,
            "remaining": 78,
            "price_tiers": [],
        }
    ]


@pytest.mark.django_db
def test_public_event_endpoint_does_not_disclose_drafts() -> None:
    Event.objects.create(
        title="Private draft",
        slug="private-draft",
        starts_at=timezone.now() + timedelta(days=30),
        venue="Secret venue",
    )

    response = Client().get("/api/v1/events/private-draft")

    assert response.status_code == 404
