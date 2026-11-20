import json
from datetime import timedelta

import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from django.utils import timezone

from catalog.models import (
    Event,
    EventAccess,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
)


def json_request(
    client: Client,
    method: str,
    path: str,
    body: dict[str, object] | None = None,
    *,
    csrf_token: str | None = None,
):
    headers = {"HTTP_X_CSRFTOKEN": csrf_token} if csrf_token else {}
    return getattr(client, method)(
        path,
        data=json.dumps(body or {}),
        content_type="application/json",
        **headers,
    )


def csrf_token(client: Client) -> str:
    response = client.get("/api/v1/auth/csrf")
    assert response.status_code == 200
    return response.json()["csrf_token"]


def create_user(email: str, *, name: str = "Event Manager"):
    return get_user_model().objects.create_user(
        username=email,
        email=email,
        first_name=name,
        password="SecurePass123!",
    )


@pytest.mark.django_db
def test_registration_creates_admin_workspace_and_session() -> None:
    client = Client()
    token = csrf_token(client)

    response = json_request(
        client,
        "post",
        "/api/v1/auth/register",
        {
            "name": "Alex Morgan",
            "email": "ALEX@example.com",
            "password": "SecurePass123!",
            "organization_name": "Studio North",
        },
        csrf_token=token,
    )

    assert response.status_code == 200
    assert response.json()["email"] == "alex@example.com"
    membership = OrganizationMembership.objects.select_related(
        "organization"
    ).get(user__email="alex@example.com")
    assert membership.role == OrganizationMembership.Role.ADMIN
    assert membership.organization.slug == "studio-north"
    session = client.get("/api/v1/auth/session")
    assert session.status_code == 200
    assert session.json()["name"] == "Alex Morgan"
    assert client.get("/api/v1/organizations").json()[0]["role"] == "admin"


@pytest.mark.django_db
def test_registration_requires_csrf_and_rejects_duplicate_email() -> None:
    user = create_user("alex@example.com")
    client = Client(enforce_csrf_checks=True)
    payload = {
        "name": "Alex Morgan",
        "email": user.email,
        "password": "SecurePass123!",
        "organization_name": "Studio North",
    }

    missing_token = json_request(
        client,
        "post",
        "/api/v1/auth/register",
        payload,
    )
    assert missing_token.status_code == 403

    token = csrf_token(client)
    duplicate = json_request(
        client,
        "post",
        "/api/v1/auth/register",
        payload,
        csrf_token=token,
    )
    assert duplicate.status_code == 409


@pytest.mark.django_db
def test_organization_dashboard_and_event_creation_are_role_scoped() -> None:
    admin = create_user("admin@example.com", name="Admin User")
    organizer = create_user("organizer@example.com", name="Event Organizer")
    viewer = create_user("viewer@example.com", name="Read Only")
    organization = Organization.objects.create(
        name="Studio North",
        created_by=admin,
    )
    admin_membership = OrganizationMembership.objects.create(
        organization=organization,
        user=admin,
        role=OrganizationMembership.Role.ADMIN,
    )
    organizer_membership = OrganizationMembership.objects.create(
        organization=organization,
        user=organizer,
        role=OrganizationMembership.Role.ORGANIZER,
    )
    viewer_membership = OrganizationMembership.objects.create(
        organization=organization,
        user=viewer,
        role=OrganizationMembership.Role.VIEWER,
    )
    payload = {
        "title": "Design Night",
        "description": "A community event.",
        "starts_at": (timezone.now() + timedelta(days=30)).isoformat(),
        "venue": "Pier 27",
        "ticket_name": "General admission",
        "ticket_description": "Standard entry.",
        "price": "25.00",
        "capacity": 120,
        "status": "published",
    }

    organizer_client = Client()
    organizer_client.force_login(organizer)
    organizer_csrf = csrf_token(organizer_client)
    created = json_request(
        organizer_client,
        "post",
        f"/api/v1/organizations/{organization.slug}/events",
        payload,
        csrf_token=organizer_csrf,
    )
    assert created.status_code == 200
    event = Event.objects.get(slug=created.json()["slug"])
    assert event.organization == organization
    assert event.ticket_types.get().capacity == 120
    configuration_path = (
        f"/api/v1/organizations/{organization.slug}/events/"
        f"{event.id}/configuration"
    )
    configuration = organizer_client.get(configuration_path)
    assert configuration.status_code == 200
    assert configuration.json()["description"] == "A community event."
    updated_start = (timezone.now() + timedelta(days=45)).isoformat()
    updated_configuration = json_request(
        organizer_client,
        "patch",
        configuration_path,
        {
            "title": "Design Night Updated",
            "description": "Updated event details.",
            "starts_at": updated_start,
            "venue": "Downtown Hall",
        },
        csrf_token=organizer_csrf,
    )
    assert updated_configuration.status_code == 200
    assert updated_configuration.json()["title"] == "Design Night Updated"
    assert event.__class__.objects.get(pk=event.pk).venue == "Downtown Hall"

    viewer_client = Client()
    viewer_client.force_login(viewer)
    assert viewer_client.get(
        f"/api/v1/organizations/{organization.slug}/dashboard"
    ).status_code == 200
    assert viewer_client.get(configuration_path).status_code == 403
    viewer_token = csrf_token(viewer_client)
    denied_create = json_request(
        viewer_client,
        "post",
        f"/api/v1/organizations/{organization.slug}/events",
        payload,
        csrf_token=viewer_token,
    )
    assert denied_create.status_code == 403
    denied_update = json_request(
        viewer_client,
        "patch",
        f"/api/v1/organizations/{organization.slug}/events/{event.id}/status",
        {"status": "draft"},
        csrf_token=viewer_token,
    )
    assert denied_update.status_code == 403

    access_client = Client()
    access_client.force_login(admin)
    access_token = csrf_token(access_client)
    granted = json_request(
        access_client,
        "put",
        f"/api/v1/organizations/{organization.slug}/events/{event.id}/access/{viewer_membership.id}",
        {"role": "organizer"},
        csrf_token=access_token,
    )
    assert granted.status_code == 200
    allowed_update = json_request(
        viewer_client,
        "patch",
        f"/api/v1/organizations/{organization.slug}/events/{event.id}/status",
        {"status": "draft"},
        csrf_token=viewer_token,
    )
    assert allowed_update.status_code == 200

    EventAccess.objects.filter(
        membership=viewer_membership,
        event=event,
    ).update(role=EventAccess.Role.VIEWER)
    denied_again = json_request(
        viewer_client,
        "patch",
        f"/api/v1/organizations/{organization.slug}/events/{event.id}/status",
        {"status": "published"},
        csrf_token=viewer_token,
    )
    assert denied_again.status_code == 403
    dashboard = organizer_client.get(
        f"/api/v1/organizations/{organization.slug}/dashboard"
    ).json()
    assert dashboard["event_count"] == 1
    assert dashboard["active_event_count"] == 0
    assert len(dashboard["revenue_trend"]) == 30
    assert dashboard["organization"]["member_count"] == 3
    assert admin_membership.role == OrganizationMembership.Role.ADMIN
    assert organizer_membership.role == OrganizationMembership.Role.ORGANIZER


@pytest.mark.django_db
def test_only_admins_invite_and_invited_email_must_match() -> None:
    admin = create_user("admin@example.com")
    invitee = create_user("invitee@example.com", name="Invited Organizer")
    other_user = create_user("other@example.com")
    organization = Organization.objects.create(name="Studio North", created_by=admin)
    OrganizationMembership.objects.create(
        organization=organization,
        user=admin,
        role=OrganizationMembership.Role.ADMIN,
    )
    organizer_membership = OrganizationMembership.objects.create(
        organization=organization,
        user=other_user,
        role=OrganizationMembership.Role.ORGANIZER,
    )

    organizer_client = Client()
    organizer_client.force_login(other_user)
    organizer_token = csrf_token(organizer_client)
    denied_invite = json_request(
        organizer_client,
        "post",
        f"/api/v1/organizations/{organization.slug}/invitations",
        {"email": invitee.email, "role": "viewer"},
        csrf_token=organizer_token,
    )
    assert denied_invite.status_code == 403

    admin_client = Client()
    admin_client.force_login(admin)
    admin_token = csrf_token(admin_client)
    invitation_response = json_request(
        admin_client,
        "post",
        f"/api/v1/organizations/{organization.slug}/invitations",
        {"email": invitee.email, "role": "organizer"},
        csrf_token=admin_token,
    )
    assert invitation_response.status_code == 200
    invitation = OrganizationInvitation.objects.get(email=invitee.email)
    listed_invitations = admin_client.get(
        f"/api/v1/organizations/{organization.slug}/invitations"
    )
    assert listed_invitations.status_code == 200
    assert listed_invitations.json()[0]["invite_url"] == (
        invitation_response.json()["invite_url"]
    )

    wrong_user_client = Client()
    wrong_user_client.force_login(other_user)
    wrong_token = csrf_token(wrong_user_client)
    wrong_account = json_request(
        wrong_user_client,
        "post",
        f"/api/v1/invitations/{invitation.token}/accept",
        csrf_token=wrong_token,
    )
    assert wrong_account.status_code == 403

    invitee_client = Client()
    invitee_client.force_login(invitee)
    invitee_token = csrf_token(invitee_client)
    accepted = json_request(
        invitee_client,
        "post",
        f"/api/v1/invitations/{invitation.token}/accept",
        csrf_token=invitee_token,
    )
    assert accepted.status_code == 200
    membership = OrganizationMembership.objects.get(
        organization=organization,
        user=invitee,
    )
    assert membership.role == OrganizationMembership.Role.ORGANIZER
    assert invitation_response.json()["invite_url"].endswith(
        f"/team/accept?token={invitation.token}"
    )
    assert organizer_membership.role == OrganizationMembership.Role.ORGANIZER


@pytest.mark.django_db
def test_organization_keeps_an_admin_and_hides_other_tenants() -> None:
    admin = create_user("admin@example.com")
    another_admin = create_user("another-admin@example.com")
    organization = Organization.objects.create(name="Studio North", created_by=admin)
    admin_membership = OrganizationMembership.objects.create(
        organization=organization,
        user=admin,
        role=OrganizationMembership.Role.ADMIN,
    )
    another_membership = OrganizationMembership.objects.create(
        organization=organization,
        user=another_admin,
        role=OrganizationMembership.Role.ADMIN,
    )

    client = Client()
    client.force_login(admin)
    token = csrf_token(client)
    downgrade = json_request(
        client,
        "put",
        f"/api/v1/organizations/{organization.slug}/members/{admin_membership.id}",
        {"role": "viewer"},
        csrf_token=token,
    )
    assert downgrade.status_code == 200
    client.force_login(another_admin)
    token = csrf_token(client)
    last_admin = json_request(
        client,
        "delete",
        f"/api/v1/organizations/{organization.slug}/members/{another_membership.id}",
        csrf_token=token,
    )
    assert last_admin.status_code == 409
    assert client.get("/api/v1/organizations/missing/dashboard").status_code == 404

