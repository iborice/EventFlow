import re
import uuid
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Literal

from django.contrib.auth import authenticate, get_user_model, login, logout
from django.contrib.auth.password_validation import validate_password
from django.conf import settings
from django.core.cache import cache
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.db.models import Prefetch, Q, Sum
from django.db.models.functions import TruncDate
from django.http import HttpRequest
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.text import slugify
from ninja import Router, Schema
from ninja.errors import HttpError
from ninja.security import django_auth
from ninja.utils import check_csrf
from pydantic import Field, field_validator, model_validator

from .payments import issue_reserved_tickets
from .seating import (
    SeatSelectionError,
    public_seat_map,
    release_expired_seat_reservations,
    select_available_seats,
)

from .models import (
    Event,
    EventAccess,
    IssuedTicket,
    Order,
    OrderItem,
    Organization,
    OrganizationInvitation,
    OrganizationMembership,
    PromotionCode,
    RecurringEventSeries,
    Seat,
    SeatMap,
    SeatReservation,
    SeatZone,
    TicketPriceTier,
    TicketType,
)

router = Router(tags=["Accounts", "Organizations"])
INVITATION_TTL = timedelta(days=7)
AUTH_RATE_LIMIT = 10
AUTH_RATE_WINDOW_SECONDS = 60


class UserSchema(Schema):
    id: int
    name: str
    email: str


class CsrfSchema(Schema):
    csrf_token: str


class LoginInput(Schema):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return clean_email(value)


class RegistrationInput(LoginInput):
    name: str
    organization_name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 150:
            raise ValueError("Name must contain 1 to 150 characters.")
        return name

    @field_validator("organization_name")
    @classmethod
    def validate_organization_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 180:
            raise ValueError("Organization name must contain 1 to 180 characters.")
        return name


class OrganizationInput(Schema):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 180:
            raise ValueError("Organization name must contain 1 to 180 characters.")
        return name


class OrganizationSchema(Schema):
    id: int
    name: str
    slug: str
    role: str
    member_count: int


class EventDashboardSchema(Schema):
    id: int
    title: str
    slug: str
    starts_at: str
    venue: str
    sold: int
    capacity: int
    revenue: str
    status: str


class EventConfigurationSchema(Schema):
    id: int
    title: str
    description: str
    starts_at: str
    venue: str
    status: str


class RevenuePointSchema(Schema):
    date: str
    revenue: str


class RecentOrderSchema(Schema):
    id: uuid.UUID
    event_title: str
    customer_name: str
    total: str
    created_at: str


class DashboardSchema(Schema):
    organization: OrganizationSchema
    total_revenue: str
    revenue_last_30_days: str
    revenue_previous_30_days: str
    tickets_sold: int
    event_count: int
    active_event_count: int
    member_count: int
    events: list[EventDashboardSchema]
    revenue_trend: list[RevenuePointSchema]
    recent_orders: list[RecentOrderSchema]


class EventCreateInput(Schema):
    title: str
    description: str = ""
    starts_at: datetime
    venue: str
    ticket_name: str
    ticket_description: str = ""
    price: Decimal
    capacity: int
    status: Literal["draft", "published"] = "draft"
    price_tiers: list["PriceTierInput"] = []

    @field_validator("title", "venue", "ticket_name")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("This field is required.")
        return text

    @field_validator("description", "ticket_description")
    @classmethod
    def trim_optional_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("starts_at")
    @classmethod
    def require_aware_date(cls, value: datetime) -> datetime:
        if timezone.is_naive(value):
            raise ValueError("Event start time must include a timezone.")
        return value

    @field_validator("price")
    @classmethod
    def validate_price(cls, value: Decimal) -> Decimal:
        if not value.is_finite() or value < 0 or value > Decimal("99999999.99"):
            raise ValueError("Ticket price must be between 0 and 99,999,999.99.")
        return value

    @field_validator("capacity")
    @classmethod
    def validate_capacity(cls, value: int) -> int:
        if not 1 <= value <= 1_000_000:
            raise ValueError("Capacity must be between 1 and 1,000,000.")
        return value

    @model_validator(mode="after")
    def validate_tier_capacity(self) -> "EventCreateInput":
        if self.price_tiers and sum(tier.capacity for tier in self.price_tiers) != self.capacity:
            raise ValueError("Price tier capacities must add up to ticket capacity.")
        return self


class EventConfigurationInput(Schema):
    title: str
    description: str
    starts_at: datetime
    venue: str

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        title = value.strip()
        if not title or len(title) > 180:
            raise ValueError("Event name must contain 1 to 180 characters.")
        return title

    @field_validator("description")
    @classmethod
    def trim_description(cls, value: str) -> str:
        description = value.strip()
        if len(description) > 5000:
            raise ValueError("Description must be at most 5,000 characters.")
        return description

    @field_validator("starts_at")
    @classmethod
    def require_aware_date(cls, value: datetime) -> datetime:
        if timezone.is_naive(value):
            raise ValueError("Event start time must include a timezone.")
        return value

    @field_validator("venue")
    @classmethod
    def validate_venue(cls, value: str) -> str:
        venue = value.strip()
        if not venue or len(venue) > 240:
            raise ValueError("Venue must contain 1 to 240 characters.")
        return venue


class PriceTierInput(Schema):
    name: str
    price: Decimal
    capacity: int

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 120:
            raise ValueError("Price tier name must contain 1 to 120 characters.")
        return name

    @field_validator("price")
    @classmethod
    def validate_price(cls, value: Decimal) -> Decimal:
        if not value.is_finite() or value < 0 or value > Decimal("99999999.99"):
            raise ValueError("Tier price must be between 0 and 99,999,999.99.")
        return value

    @field_validator("capacity")
    @classmethod
    def validate_capacity(cls, value: int) -> int:
        if not 1 <= value <= 1_000_000:
            raise ValueError("Tier capacity must be between 1 and 1,000,000.")
        return value


class RecurringOccurrenceInput(Schema):
    starts_at: datetime
    price: Decimal
    capacity: int
    price_tiers: list[PriceTierInput] = []

    @field_validator("starts_at")
    @classmethod
    def require_aware_date(cls, value: datetime) -> datetime:
        if timezone.is_naive(value):
            raise ValueError("Occurrence start time must include a timezone.")
        return value

    @field_validator("price")
    @classmethod
    def validate_price(cls, value: Decimal) -> Decimal:
        if not value.is_finite() or value < 0 or value > Decimal("99999999.99"):
            raise ValueError("Ticket price must be between 0 and 99,999,999.99.")
        return value

    @field_validator("capacity")
    @classmethod
    def validate_capacity(cls, value: int) -> int:
        if not 1 <= value <= 1_000_000:
            raise ValueError("Capacity must be between 1 and 1,000,000.")
        return value

    @model_validator(mode="after")
    def validate_tier_capacity(self) -> "RecurringOccurrenceInput":
        if self.price_tiers and sum(tier.capacity for tier in self.price_tiers) != self.capacity:
            raise ValueError("Price tier capacities must add up to occurrence capacity.")
        return self


class RecurringEventInput(Schema):
    title: str
    description: str = ""
    venue: str
    ticket_name: str
    ticket_description: str = ""
    status: Literal["draft", "published"] = "draft"
    occurrences: list[RecurringOccurrenceInput]

    @field_validator("title", "venue", "ticket_name")
    @classmethod
    def validate_required_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("This field is required.")
        return text

    @field_validator("description", "ticket_description")
    @classmethod
    def trim_optional_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("occurrences")
    @classmethod
    def validate_occurrences(
        cls,
        value: list[RecurringOccurrenceInput],
    ) -> list[RecurringOccurrenceInput]:
        if not 1 <= len(value) <= 1200:
            raise ValueError("A recurring series must contain 1 to 1,200 dates.")
        timestamps = [occurrence.starts_at for occurrence in value]
        if len(set(timestamps)) != len(timestamps):
            raise ValueError("Recurring event dates must be unique.")
        return value


class RecurringSeriesSchema(Schema):
    id: int
    title: str
    events: list[EventDashboardSchema]


class SeatingZoneInput(Schema):
    key: str
    name: str
    color: str
    ticket_type_id: int

    @field_validator("key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        key = value.strip().lower()
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", key):
            raise ValueError("Zone keys must use letters, numbers, and dashes.")
        return key

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 80:
            raise ValueError("Zone names must contain 1 to 80 characters.")
        return name

    @field_validator("color")
    @classmethod
    def validate_color(cls, value: str) -> str:
        color = value.strip().upper()
        if not re.fullmatch(r"#[0-9A-F]{6}", color):
            raise ValueError("Zone colors must be six-digit hexadecimal colors.")
        return color


class SeatDefinitionInput(Schema):
    label: str
    row: str
    number: int
    x: int
    y: int
    zone_key: str
    blocked: bool = False

    @field_validator("label", "row", "zone_key")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Seat labels, rows, and zones are required.")
        return text


class SeatMapInput(Schema):
    width: int
    height: int
    zones: list[SeatingZoneInput] = Field(min_length=1, max_length=20)
    seats: list[SeatDefinitionInput] = Field(min_length=1, max_length=3000)

    @field_validator("width", "height")
    @classmethod
    def validate_dimensions(cls, value: int) -> int:
        if not 100 <= value <= 5000:
            raise ValueError("Seat map dimensions must be between 100 and 5,000.")
        return value

    @model_validator(mode="after")
    def validate_seat_references(self) -> "SeatMapInput":
        zone_keys = [zone.key for zone in self.zones]
        labels = [seat.label for seat in self.seats]
        if len(zone_keys) != len(set(zone_keys)):
            raise ValueError("Zone keys must be unique.")
        if len(labels) != len(set(labels)):
            raise ValueError("Seat labels must be unique.")
        known_zones = set(zone_keys)
        if any(seat.zone_key not in known_zones for seat in self.seats):
            raise ValueError("Every seat must belong to a defined zone.")
        if any(
            seat.number < 1
            or seat.number > 999
            or seat.x > self.width
            or seat.y > self.height
            or len(seat.row) > 12
            for seat in self.seats
        ):
            raise ValueError("Seat numbers, positions, or row labels are out of range.")
        return self


class SeatZoneSchema(Schema):
    key: str
    name: str
    color: str
    ticket_type_id: int
    ticket_name: str
    price: str


class SeatDefinitionSchema(Schema):
    id: int
    label: str
    row: str
    number: int
    x: int
    y: int
    zone_key: str
    zone_color: str
    ticket_type_id: int
    blocked: bool
    available: bool


class SeatingPriceTierSchema(Schema):
    id: int
    name: str
    price: str
    remaining: int


class SeatingTicketSchema(Schema):
    id: int
    name: str
    price: str
    capacity: int
    remaining: int
    hidden: bool
    price_tiers: list[SeatingPriceTierSchema]


class SeatingWorkspaceSchema(Schema):
    event_id: int
    event_title: str
    configured: bool
    width: int
    height: int
    ticket_types: list[SeatingTicketSchema]
    zones: list[SeatZoneSchema]
    seats: list[SeatDefinitionSchema]


class BoxOfficeSaleInput(Schema):
    ticket_type_id: int
    price_tier_id: int | None = None
    quantity: int
    customer_name: str = "Door sale"
    customer_email: str | None = None
    payment_method: Literal["cash", "card", "comp"]
    cash_received: Decimal | None = None
    seat_ids: list[int] = Field(default_factory=list)
    idempotency_key: uuid.UUID

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, value: int) -> int:
        if not 1 <= value <= 6:
            raise ValueError("Quantity must be between 1 and 6.")
        return value

    @field_validator("customer_name")
    @classmethod
    def validate_customer_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 180:
            raise ValueError("Customer name must contain 1 to 180 characters.")
        return name

    @field_validator("customer_email")
    @classmethod
    def normalize_optional_email(cls, value: str | None) -> str | None:
        return clean_email(value) if value else None

    @field_validator("seat_ids")
    @classmethod
    def validate_seat_ids(cls, value: list[int]) -> list[int]:
        if len(value) > 6 or len(value) != len(set(value)):
            raise ValueError("Choose up to 6 distinct seats.")
        return value

    @field_validator("cash_received")
    @classmethod
    def validate_cash_amount(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and (
            not value.is_finite()
            or value < 0
            or value > Decimal("9999999999.99")
        ):
            raise ValueError("Cash received must be a non-negative amount.")
        return value


class BoxOfficeSaleSchema(Schema):
    order_id: uuid.UUID
    status: str
    event_slug: str
    ticket_name: str
    quantity: int
    payment_method: str
    subtotal: str
    total: str
    cash_received: str | None
    change_due: str
    seat_labels: list[str]
    ticket_ids: list[uuid.UUID]


class CheckInSyncInput(Schema):
    ticket_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)

    @field_validator("ticket_ids")
    @classmethod
    def validate_unique_ticket_ids(cls, value: list[uuid.UUID]) -> list[uuid.UUID]:
        if len(value) != len(set(value)):
            raise ValueError("Ticket IDs must be unique.")
        return value


class CheckInResultSchema(Schema):
    ticket_id: uuid.UUID
    status: Literal["checked_in", "already_checked_in", "invalid"]
    ticket_name: str | None
    attendee_name: str | None
    seat_label: str | None
    checked_in_at: str | None


class CheckInSyncSchema(Schema):
    results: list[CheckInResultSchema]


class CheckInTicketSchema(Schema):
    ticket_id: uuid.UUID
    ticket_name: str
    attendee_name: str
    attendee_email: str
    seat_label: str | None
    checked_in_at: str | None


class CheckInSearchSchema(Schema):
    tickets: list[CheckInTicketSchema]
    total: int


class PromotionCreateInput(Schema):
    code: str
    discount_type: Literal["percent", "fixed"]
    value: Decimal
    max_uses: int | None = None
    starts_at: datetime | None = None
    expires_at: datetime | None = None
    ticket_type_id: int | None = None
    reveals_hidden_tickets: bool = False

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        code = value.strip().upper()
        if not 3 <= len(code) <= 64 or not all(
            character.isalnum() or character in "_-" for character in code
        ):
            raise ValueError("Code must contain 3 to 64 letters, numbers, dashes, or underscores.")
        return code

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: Decimal) -> Decimal:
        if not value.is_finite() or value <= 0 or value > Decimal("99999999.99"):
            raise ValueError("Discount value must be greater than zero.")
        return value

    @field_validator("max_uses")
    @classmethod
    def validate_max_uses(cls, value: int | None) -> int | None:
        if value is not None and not 1 <= value <= 1_000_000:
            raise ValueError("Usage limit must be between 1 and 1,000,000.")
        return value

    @field_validator("starts_at", "expires_at")
    @classmethod
    def require_aware_datetime(cls, value: datetime | None) -> datetime | None:
        if value is not None and timezone.is_naive(value):
            raise ValueError("Promotion dates must include a timezone.")
        return value

    @model_validator(mode="after")
    def validate_rules(self) -> "PromotionCreateInput":
        if self.discount_type == "percent" and self.value > 100:
            raise ValueError("Percentage discounts cannot exceed 100.")
        if (
            self.starts_at is not None
            and self.expires_at is not None
            and self.expires_at <= self.starts_at
        ):
            raise ValueError("Promotion expiry must be after its start date.")
        return self


class PromotionSchema(Schema):
    id: int
    event_id: int
    ticket_type_id: int | None
    code: str
    discount_type: str
    value: str
    max_uses: int | None
    used_count: int
    starts_at: str | None
    expires_at: str | None
    active: bool
    reveals_hidden_tickets: bool

class EventStatusInput(Schema):
    status: Literal["draft", "published", "cancelled"]


class InvitationInput(Schema):
    email: str
    role: Literal["organizer", "viewer"]

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return clean_email(value)


class MembershipRoleInput(Schema):
    role: Literal["admin", "organizer", "viewer"]


class EventAccessInput(Schema):
    role: Literal["organizer", "viewer"]


class MemberEventAccessSchema(Schema):
    event_id: int
    event_title: str
    role: str


class MemberSchema(Schema):
    id: int
    name: str
    email: str
    role: str
    joined_at: str
    event_access: list[MemberEventAccessSchema]


class InvitationSchema(Schema):
    id: int
    email: str
    role: str
    created_at: str
    expires_at: str
    accepted_at: str | None
    invite_url: str | None


class CreatedInvitationSchema(InvitationSchema):
    invite_url: str


def clean_email(value: str) -> str:
    email = value.strip().lower()
    try:
        validate_email(email)
    except DjangoValidationError as exc:
        raise ValueError("Enter a valid email address.") from exc
    if len(email) > 150:
        raise ValueError("Email address must be 150 characters or fewer.")
    return email


def csrf_token(request: HttpRequest) -> dict[str, str]:
    return {"csrf_token": get_token(request)}


def enforce_csrf(request: HttpRequest) -> None:
    if check_csrf(request) is not None:
        raise HttpError(403, "CSRF token missing or invalid.")


def enforce_auth_rate_limit(request: HttpRequest, action: str) -> None:
    address = (
        request.META.get("HTTP_X_REAL_IP")
        or request.META.get("REMOTE_ADDR")
        or "unknown"
    )[:64]
    key = f"auth-rate:{action}:{address}"
    if cache.add(key, 1, timeout=AUTH_RATE_WINDOW_SECONDS):
        return
    try:
        attempts = cache.incr(key)
    except ValueError:
        cache.add(key, 1, timeout=AUTH_RATE_WINDOW_SECONDS)
        attempts = 1
    if attempts > AUTH_RATE_LIMIT:
        raise HttpError(429, "Too many attempts. Try again shortly.")


def serialize_user(user) -> dict[str, object]:
    return {
        "id": user.pk,
        "name": user.get_full_name().strip() or user.email or user.username,
        "email": user.email,
    }


def get_membership(user, organization_slug: str) -> OrganizationMembership:
    return get_object_or_404(
        OrganizationMembership.objects.select_related("organization", "user"),
        organization__slug=organization_slug,
        user=user,
    )


def require_admin(membership: OrganizationMembership) -> None:
    if membership.role != OrganizationMembership.Role.ADMIN:
        raise HttpError(403, "Organization admin permission is required.")


def can_manage_event(membership: OrganizationMembership, event: Event) -> bool:
    if membership.role == OrganizationMembership.Role.ADMIN:
        return True
    explicit_role = EventAccess.objects.filter(
        membership=membership,
        event=event,
    ).values_list("role", flat=True).first()
    return (
        explicit_role or membership.role
    ) == OrganizationMembership.Role.ORGANIZER


def serialize_organization(
    organization: Organization,
    membership: OrganizationMembership,
) -> dict[str, object]:
    return {
        "id": organization.pk,
        "name": organization.name,
        "slug": organization.slug,
        "role": membership.role,
        "member_count": organization.memberships.count(),
    }


@router.get("/auth/csrf", response=CsrfSchema)
def get_csrf_token(request: HttpRequest) -> dict[str, str]:
    return csrf_token(request)


@router.post("/auth/register", response=UserSchema)
def register(request: HttpRequest, payload: RegistrationInput) -> dict[str, object]:
    enforce_auth_rate_limit(request, "register")
    enforce_csrf(request)
    user_model = get_user_model()
    if user_model.objects.filter(email__iexact=payload.email).exists():
        raise HttpError(409, "An account with this email already exists.")

    user = user_model(
        username=payload.email,
        email=payload.email,
        first_name=payload.name,
    )
    try:
        validate_password(payload.password, user=user)
    except DjangoValidationError as exc:
        raise HttpError(400, " ".join(exc.messages)) from exc

    try:
        with transaction.atomic():
            user = user_model.objects.create_user(
                username=payload.email,
                email=payload.email,
                first_name=payload.name,
                password=payload.password,
            )
            organization = Organization.objects.create(
                name=payload.organization_name,
                created_by=user,
            )
            OrganizationMembership.objects.create(
                organization=organization,
                user=user,
                role=OrganizationMembership.Role.ADMIN,
            )
    except IntegrityError as exc:
        raise HttpError(409, "An account with this email already exists.") from exc

    login(request, user)
    return serialize_user(user)


@router.post("/auth/login", response=UserSchema)
def sign_in(request: HttpRequest, payload: LoginInput) -> dict[str, object]:
    enforce_auth_rate_limit(request, "login")
    enforce_csrf(request)
    user = authenticate(
        request,
        username=payload.email,
        password=payload.password,
    )
    if user is None:
        raise HttpError(401, "Email or password is incorrect.")
    login(request, user)
    return serialize_user(user)


@router.get("/auth/session", auth=django_auth, response=UserSchema)
def current_session(request: HttpRequest) -> dict[str, object]:
    return serialize_user(request.user)


@router.post("/auth/logout", auth=django_auth, response=dict[str, bool])
def sign_out(request: HttpRequest) -> dict[str, bool]:
    logout(request)
    return {"signed_out": True}


@router.get("/organizations", auth=django_auth, response=list[OrganizationSchema])
def list_organizations(request: HttpRequest) -> list[dict[str, object]]:
    memberships = OrganizationMembership.objects.filter(
        user=request.user
    ).select_related("organization")
    return [
        serialize_organization(membership.organization, membership)
        for membership in memberships
    ]


@router.post("/organizations", auth=django_auth, response=OrganizationSchema)
def create_organization(
    request: HttpRequest,
    payload: OrganizationInput,
) -> dict[str, object]:
    with transaction.atomic():
        organization = Organization.objects.create(
            name=payload.name,
            created_by=request.user,
        )
        membership = OrganizationMembership.objects.create(
            organization=organization,
            user=request.user,
            role=OrganizationMembership.Role.ADMIN,
        )
    return serialize_organization(organization, membership)


@router.get(
    "/organizations/{organization_slug}/dashboard",
    auth=django_auth,
    response=DashboardSchema,
)
def organization_dashboard(
    request: HttpRequest,
    organization_slug: str,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    organization = membership.organization
    now = timezone.now()
    today = timezone.localdate()
    window_start = now - timedelta(days=30)
    previous_start = now - timedelta(days=60)

    confirmed_orders = Order.objects.filter(
        event__organization=organization,
        status=Order.Status.CONFIRMED,
    )
    totals = confirmed_orders.aggregate(total=Sum("total"))
    recent_total = confirmed_orders.filter(created_at__gte=window_start).aggregate(
        total=Sum("total")
    )
    previous_total = confirmed_orders.filter(
        created_at__gte=previous_start,
        created_at__lt=window_start,
    ).aggregate(total=Sum("total"))
    daily_totals = {
        row["day"]: row["total"]
        for row in confirmed_orders.filter(created_at__gte=window_start)
        .annotate(day=TruncDate("created_at"))
        .values("day")
        .annotate(total=Sum("total"))
    }
    revenue_trend = [
        {
            "date": (today - timedelta(days=offset)).isoformat(),
            "revenue": str(
                daily_totals.get(today - timedelta(days=offset), Decimal("0.00"))
            ),
        }
        for offset in range(29, -1, -1)
    ]

    events = list(
        Event.objects.filter(organization=organization)
        .prefetch_related(
            "ticket_types",
            Prefetch(
                "orders",
                queryset=Order.objects.filter(status=Order.Status.CONFIRMED),
                to_attr="confirmed_orders",
            ),
        )
        .order_by("starts_at")
    )
    serialized_events: list[dict[str, object]] = []
    tickets_sold = 0
    for event in events:
        ticket_types = list(event.ticket_types.all())
        sold = sum(ticket.sold for ticket in ticket_types)
        capacity = sum(ticket.capacity for ticket in ticket_types)
        revenue = sum(
            (order.total for order in event.confirmed_orders),
            Decimal("0.00"),
        )
        tickets_sold += sold
        status = event.status
        if (
            event.status == Event.Status.PUBLISHED
            and capacity > 0
            and sold >= capacity
        ):
            status = "sold_out"
        serialized_events.append(
            {
                "id": event.pk,
                "title": event.title,
                "slug": event.slug,
                "starts_at": event.starts_at.isoformat(),
                "venue": event.venue,
                "sold": sold,
                "capacity": capacity,
                "revenue": str(revenue),
                "status": status,
            }
        )

    recent_orders = confirmed_orders.select_related("event").order_by(
        "-created_at"
    )[:5]
    members = organization.memberships.count()
    return {
        "organization": serialize_organization(organization, membership),
        "total_revenue": str(totals["total"] or Decimal("0.00")),
        "revenue_last_30_days": str(recent_total["total"] or Decimal("0.00")),
        "revenue_previous_30_days": str(previous_total["total"] or Decimal("0.00")),
        "tickets_sold": tickets_sold,
        "event_count": len(events),
        "active_event_count": sum(
            event.status == Event.Status.PUBLISHED for event in events
        ),
        "member_count": members,
        "events": serialized_events,
        "revenue_trend": revenue_trend,
        "recent_orders": [
            {
                "id": order.id,
                "event_title": order.event.title,
                "customer_name": order.customer_name,
                "total": str(order.total),
                "created_at": order.created_at.isoformat(),
            }
            for order in recent_orders
        ],
    }


@router.post(
    "/organizations/{organization_slug}/events",
    auth=django_auth,
    response=EventDashboardSchema,
)
def create_organization_event(
    request: HttpRequest,
    organization_slug: str,
    payload: EventCreateInput,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    if membership.role == OrganizationMembership.Role.VIEWER:
        raise HttpError(403, "Organizer permission is required to create events.")

    base_slug = slugify(payload.title)[:180] or "event"
    event_slug = base_slug
    if Event.objects.filter(slug=event_slug).exists():
        event_slug = f"{base_slug}-{uuid.uuid4().hex[:8]}"
    with transaction.atomic():
        event = Event.objects.create(
            title=payload.title.strip(),
            slug=event_slug,
            organization=membership.organization,
            description=payload.description.strip(),
            starts_at=payload.starts_at,
            venue=payload.venue.strip(),
            status=payload.status,
        )
        ticket = TicketType.objects.create(
            event=event,
            name=payload.ticket_name.strip(),
            description=payload.ticket_description.strip(),
            price=payload.price,
            capacity=payload.capacity,
        )
        create_price_tiers(ticket, payload.price_tiers)
    return {
        **serialize_event_dashboard(event, [ticket]),
    }


@router.post(
    "/organizations/{organization_slug}/recurring-events",
    auth=django_auth,
    response=RecurringSeriesSchema,
)
def create_recurring_event_series(
    request: HttpRequest,
    organization_slug: str,
    payload: RecurringEventInput,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    if membership.role == OrganizationMembership.Role.VIEWER:
        raise HttpError(403, "Organizer permission is required to create events.")

    created_events: list[tuple[Event, TicketType]] = []
    with transaction.atomic():
        series = RecurringEventSeries.objects.create(
            organization=membership.organization,
            title=payload.title.strip(),
            description=payload.description.strip(),
            venue=payload.venue.strip(),
        )
        slugs = unique_event_slugs(payload.title, len(payload.occurrences))
        for occurrence, event_slug in zip(payload.occurrences, slugs):
            event = Event.objects.create(
                title=payload.title.strip(),
                slug=event_slug,
                organization=membership.organization,
                series=series,
                description=payload.description.strip(),
                starts_at=occurrence.starts_at,
                venue=payload.venue.strip(),
                status=payload.status,
            )
            ticket = TicketType.objects.create(
                event=event,
                name=payload.ticket_name.strip(),
                description=payload.ticket_description.strip(),
                price=occurrence.price,
                capacity=occurrence.capacity,
            )
            create_price_tiers(ticket, occurrence.price_tiers)
            created_events.append((event, ticket))

    return {
        "id": series.pk,
        "title": series.title,
        "events": [
            serialize_event_dashboard(event, [ticket])
            for event, ticket in created_events
        ],
    }


@router.get(
    "/organizations/{organization_slug}/events/{event_id}/configuration",
    auth=django_auth,
    response=EventConfigurationSchema,
)
def get_event_configuration(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
) -> dict[str, object]:
    _, event = organization_event(request, organization_slug, event_id)
    return {
        "id": event.pk,
        "title": event.title,
        "description": event.description,
        "starts_at": event.starts_at.isoformat(),
        "venue": event.venue,
        "status": event.status,
    }


@router.patch(
    "/organizations/{organization_slug}/events/{event_id}/configuration",
    auth=django_auth,
    response=EventConfigurationSchema,
)
def update_event_configuration(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    payload: EventConfigurationInput,
) -> dict[str, object]:
    _, event = organization_event(request, organization_slug, event_id)
    event.title = payload.title
    event.description = payload.description
    event.starts_at = payload.starts_at
    event.venue = payload.venue
    event.save(update_fields=["title", "description", "starts_at", "venue", "updated_at"])
    return {
        "id": event.pk,
        "title": event.title,
        "description": event.description,
        "starts_at": event.starts_at.isoformat(),
        "venue": event.venue,
        "status": event.status,
    }


@router.patch(
    "/organizations/{organization_slug}/events/{event_id}/status",
    auth=django_auth,
    response=EventDashboardSchema,
)
def update_event_status(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    payload: EventStatusInput,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    event = get_object_or_404(
        Event.objects.filter(organization=membership.organization),
        pk=event_id,
    )
    if not can_manage_event(membership, event):
        raise HttpError(403, "Organizer permission is required for this event.")
    event.status = payload.status
    event.save(update_fields=["status", "updated_at"])
    ticket_types = list(event.ticket_types.all())
    sold = sum(ticket.sold for ticket in ticket_types)
    capacity = sum(ticket.capacity for ticket in ticket_types)
    revenue = Order.objects.filter(
        event=event,
        status=Order.Status.CONFIRMED,
    ).aggregate(total=Sum("total"))["total"] or Decimal("0.00")
    status = "sold_out" if (
        event.status == Event.Status.PUBLISHED and capacity > 0 and sold >= capacity
    ) else event.status
    return {
        "id": event.pk,
        "title": event.title,
        "slug": event.slug,
        "starts_at": event.starts_at.isoformat(),
        "venue": event.venue,
        "sold": sold,
        "capacity": capacity,
        "revenue": str(revenue),
        "status": status,
    }


@router.get(
    "/organizations/{organization_slug}/events/{event_id}/promotions",
    auth=django_auth,
    response=list[PromotionSchema],
)
def list_event_promotions(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
) -> list[dict[str, object]]:
    membership = get_membership(request.user, organization_slug)
    event = get_object_or_404(
        Event.objects.filter(organization=membership.organization),
        pk=event_id,
    )
    if not can_manage_event(membership, event):
        raise HttpError(403, "Organizer permission is required for this event.")
    return [serialize_promotion(promotion) for promotion in event.promotion_codes.all()]


@router.post(
    "/organizations/{organization_slug}/events/{event_id}/promotions",
    auth=django_auth,
    response=PromotionSchema,
)
def create_event_promotion(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    payload: PromotionCreateInput,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    event = get_object_or_404(
        Event.objects.filter(organization=membership.organization),
        pk=event_id,
    )
    if not can_manage_event(membership, event):
        raise HttpError(403, "Organizer permission is required for this event.")
    ticket = None
    if payload.ticket_type_id is not None:
        ticket = get_object_or_404(
            TicketType.objects.filter(event=event),
            pk=payload.ticket_type_id,
        )
        if ticket.hidden and not payload.reveals_hidden_tickets:
            raise HttpError(
                400,
                "A code for a hidden ticket must reveal hidden tickets.",
            )
    try:
        with transaction.atomic():
            promotion = PromotionCode.objects.create(
                event=event,
                ticket_type=ticket,
                code=payload.code,
                discount_type=payload.discount_type,
                value=payload.value,
                max_uses=payload.max_uses,
                starts_at=payload.starts_at,
                expires_at=payload.expires_at,
                reveals_hidden_tickets=payload.reveals_hidden_tickets,
            )
    except IntegrityError as exc:
        raise HttpError(409, "A promotion with this code already exists.") from exc
    return serialize_promotion(promotion)


@router.get(
    "/organizations/{organization_slug}/members",
    auth=django_auth,
    response=list[MemberSchema],
)
def list_members(
    request: HttpRequest,
    organization_slug: str,
) -> list[dict[str, object]]:
    membership = get_membership(request.user, organization_slug)
    members = OrganizationMembership.objects.filter(
        organization=membership.organization
    ).select_related("user").prefetch_related(
        Prefetch(
            "event_accesses",
            queryset=EventAccess.objects.filter(
                event__organization=membership.organization
            ).select_related("event"),
        )
    )
    return [
        {
            "id": member.pk,
            "name": member.user.get_full_name().strip()
            or member.user.email
            or member.user.username,
            "email": member.user.email,
            "role": member.role,
            "joined_at": member.joined_at.isoformat(),
            "event_access": [
                {
                    "event_id": access.event_id,
                    "event_title": access.event.title,
                    "role": access.role,
                }
                for access in member.event_accesses.all()
            ],
        }
        for member in members
    ]


@router.put(
    "/organizations/{organization_slug}/members/{membership_id}",
    auth=django_auth,
    response=MemberSchema,
)
def update_member_role(
    request: HttpRequest,
    organization_slug: str,
    membership_id: int,
    payload: MembershipRoleInput,
) -> dict[str, object]:
    actor = get_membership(request.user, organization_slug)
    require_admin(actor)
    member = get_object_or_404(
        OrganizationMembership.objects.select_related("user").filter(
            organization=actor.organization
        ),
        pk=membership_id,
    )
    if (
        member.role == OrganizationMembership.Role.ADMIN
        and payload.role != OrganizationMembership.Role.ADMIN
        and actor.organization.memberships.filter(
            role=OrganizationMembership.Role.ADMIN
        ).count()
        <= 1
    ):
        raise HttpError(409, "The organization must keep at least one admin.")
    member.role = payload.role
    member.save(update_fields=["role"])
    return serialize_member(member)


@router.delete(
    "/organizations/{organization_slug}/members/{membership_id}",
    response={204: None},
    auth=django_auth,
)
def remove_member(
    request: HttpRequest,
    organization_slug: str,
    membership_id: int,
) -> None:
    actor = get_membership(request.user, organization_slug)
    require_admin(actor)
    member = get_object_or_404(
        OrganizationMembership.objects.filter(organization=actor.organization),
        pk=membership_id,
    )
    if (
        member.role == OrganizationMembership.Role.ADMIN
        and actor.organization.memberships.filter(
            role=OrganizationMembership.Role.ADMIN
        ).count()
        <= 1
    ):
        raise HttpError(409, "The organization must keep at least one admin.")
    member.delete()


def serialize_member(member: OrganizationMembership) -> dict[str, object]:
    accesses = member.event_accesses.select_related("event").all()
    return {
        "id": member.pk,
        "name": member.user.get_full_name().strip()
        or member.user.email
        or member.user.username,
        "email": member.user.email,
        "role": member.role,
        "joined_at": member.joined_at.isoformat(),
        "event_access": [
            {
                "event_id": access.event_id,
                "event_title": access.event.title,
                "role": access.role,
            }
            for access in accesses
        ],
    }


def create_price_tiers(
    ticket: TicketType,
    tiers: list[PriceTierInput],
) -> None:
    if not tiers:
        return
    TicketPriceTier.objects.bulk_create(
        [
            TicketPriceTier(
                ticket_type=ticket,
                name=tier.name,
                price=tier.price,
                capacity=tier.capacity,
                position=position,
            )
            for position, tier in enumerate(tiers)
        ]
    )


def unique_event_slugs(title: str, count: int) -> list[str]:
    base_slug = slugify(title)[:180] or "event"
    existing = set(
        Event.objects.filter(slug__startswith=base_slug).values_list("slug", flat=True)
    )
    slugs: list[str] = []
    suffix = 1
    while len(slugs) < count:
        candidate = base_slug if suffix == 1 else f"{base_slug}-{suffix}"
        if candidate not in existing:
            slugs.append(candidate)
            existing.add(candidate)
        suffix += 1
    return slugs


def serialize_event_dashboard(
    event: Event,
    ticket_types: list[TicketType] | None = None,
) -> dict[str, object]:
    tickets = (
        ticket_types
        if ticket_types is not None
        else list(event.ticket_types.all())
    )
    sold = sum(ticket.sold for ticket in tickets)
    capacity = sum(ticket.capacity for ticket in tickets)
    status = event.status
    if (
        event.status == Event.Status.PUBLISHED
        and capacity > 0
        and sold >= capacity
    ):
        status = "sold_out"
    return {
        "id": event.pk,
        "title": event.title,
        "slug": event.slug,
        "starts_at": event.starts_at.isoformat(),
        "venue": event.venue,
        "sold": sold,
        "capacity": capacity,
        "revenue": "0.00",
        "status": status,
    }


def serialize_promotion(promotion: PromotionCode) -> dict[str, object]:
    return {
        "id": promotion.pk,
        "event_id": promotion.event_id,
        "ticket_type_id": promotion.ticket_type_id,
        "code": promotion.code,
        "discount_type": promotion.discount_type,
        "value": str(promotion.value),
        "max_uses": promotion.max_uses,
        "used_count": promotion.used_count,
        "starts_at": (
            promotion.starts_at.isoformat() if promotion.starts_at else None
        ),
        "expires_at": (
            promotion.expires_at.isoformat() if promotion.expires_at else None
        ),
        "active": promotion.active,
        "reveals_hidden_tickets": promotion.reveals_hidden_tickets,
    }


@router.get(
    "/organizations/{organization_slug}/invitations",
    auth=django_auth,
    response=list[InvitationSchema],
)
def list_invitations(
    request: HttpRequest,
    organization_slug: str,
) -> list[dict[str, object]]:
    membership = get_membership(request.user, organization_slug)
    require_admin(membership)
    invitations = OrganizationInvitation.objects.filter(
        organization=membership.organization
    )
    return [
        {
            "id": invitation.pk,
            "email": invitation.email,
            "role": invitation.role,
            "created_at": invitation.created_at.isoformat(),
            "expires_at": invitation.expires_at.isoformat(),
            "accepted_at": (
                invitation.accepted_at.isoformat()
                if invitation.accepted_at
                else None
            ),
            "invite_url": (
                f"{settings.PUBLIC_SITE_URL}/team/accept?token={invitation.token}"
            ),
        }
        for invitation in invitations
    ]


@router.post(
    "/organizations/{organization_slug}/invitations",
    auth=django_auth,
    response=CreatedInvitationSchema,
)
def create_invitation(
    request: HttpRequest,
    organization_slug: str,
    payload: InvitationInput,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    require_admin(membership)
    if OrganizationMembership.objects.filter(
        organization=membership.organization,
        user__email__iexact=payload.email,
    ).exists():
        raise HttpError(409, "This person is already a member.")
    invitation = OrganizationInvitation.objects.create(
        organization=membership.organization,
        email=payload.email,
        role=payload.role,
        invited_by=request.user,
        expires_at=timezone.now() + INVITATION_TTL,
    )
    return {
        "id": invitation.pk,
        "email": invitation.email,
        "role": invitation.role,
        "created_at": invitation.created_at.isoformat(),
        "expires_at": invitation.expires_at.isoformat(),
        "accepted_at": None,
        "invite_url": (
            f"{settings.PUBLIC_SITE_URL}/team/accept?token={invitation.token}"
        ),
    }


@router.post(
    "/invitations/{token}/accept",
    auth=django_auth,
    response=OrganizationSchema,
)
def accept_invitation(
    request: HttpRequest,
    token: uuid.UUID,
) -> dict[str, object]:
    with transaction.atomic():
        invitation = get_object_or_404(
            OrganizationInvitation.objects.select_for_update().select_related(
                "organization",
                "invited_by",
            ),
            token=token,
        )
        if invitation.accepted_at:
            membership = OrganizationMembership.objects.filter(
                organization=invitation.organization,
                user=request.user,
            ).first()
            if membership is not None:
                return serialize_organization(invitation.organization, membership)
            raise HttpError(409, "This invitation has already been accepted.")
        if invitation.expires_at <= timezone.now():
            raise HttpError(410, "This invitation has expired.")
        if request.user.email.strip().lower() != invitation.email:
            raise HttpError(403, "Sign in with the email address this invite was sent to.")
        if OrganizationMembership.objects.filter(
            organization=invitation.organization,
            user=request.user,
        ).exists():
            raise HttpError(409, "You are already a member of this organization.")
        membership = OrganizationMembership.objects.create(
            organization=invitation.organization,
            user=request.user,
            role=invitation.role,
        )
        invitation.accepted_at = timezone.now()
        invitation.save(update_fields=["accepted_at"])
    return serialize_organization(invitation.organization, membership)


@router.put(
    "/organizations/{organization_slug}/events/{event_id}/access/{membership_id}",
    auth=django_auth,
    response=MemberSchema,
)
def set_event_access(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    membership_id: int,
    payload: EventAccessInput,
) -> dict[str, object]:
    actor = get_membership(request.user, organization_slug)
    require_admin(actor)
    event = get_object_or_404(
        Event.objects.filter(organization=actor.organization),
        pk=event_id,
    )
    member = get_object_or_404(
        OrganizationMembership.objects.select_related("user").filter(
            organization=actor.organization
        ),
        pk=membership_id,
    )
    EventAccess.objects.update_or_create(
        membership=member,
        event=event,
        defaults={"role": payload.role},
    )
    return serialize_member(member)


@router.delete(
    "/organizations/{organization_slug}/events/{event_id}/access/{membership_id}",
    response={204: None},
    auth=django_auth,
)
def clear_event_access(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    membership_id: int,
) -> None:
    actor = get_membership(request.user, organization_slug)
    require_admin(actor)
    event = get_object_or_404(
        Event.objects.filter(organization=actor.organization),
        pk=event_id,
    )
    member = get_object_or_404(
        OrganizationMembership.objects.filter(organization=actor.organization),
        pk=membership_id,
    )
    EventAccess.objects.filter(membership=member, event=event).delete()


def serialize_seating_workspace(event: Event) -> dict[str, object]:
    seat_map = public_seat_map(event)
    if seat_map is None:
        seat_map = {"width": 1000, "height": 640, "zones": [], "seats": []}
    tickets = event.ticket_types.filter(active=True).order_by("name", "id")
    return {
        "event_id": event.pk,
        "event_title": event.title,
        "configured": bool(seat_map["zones"]),
        "width": seat_map["width"],
        "height": seat_map["height"],
        "ticket_types": [
            {
                "id": ticket.pk,
                "name": ticket.name,
                "price": str(ticket.price),
                "capacity": ticket.capacity,
                "remaining": ticket.remaining,
                "hidden": ticket.hidden,
                "price_tiers": [
                    {
                        "id": tier.pk,
                        "name": tier.name,
                        "price": str(tier.price),
                        "remaining": tier.remaining,
                    }
                    for tier in ticket.price_tiers.all()
                ],
            }
            for ticket in tickets
        ],
        "zones": seat_map["zones"],
        "seats": seat_map["seats"],
    }


def serialize_box_office_sale(order: Order) -> dict[str, object]:
    item = order.items.select_related("ticket_type").first()
    if item is None:
        raise HttpError(500, "The box-office order has no ticket item.")
    seats = list(
        SeatReservation.objects.filter(order_item=item)
        .select_related("seat")
        .order_by("seat__row_label", "seat__seat_number")
    )
    return {
        "order_id": order.pk,
        "status": order.status,
        "event_slug": order.event.slug,
        "ticket_name": item.ticket_type.name,
        "quantity": item.quantity,
        "payment_method": order.payment_method,
        "subtotal": str(order.subtotal),
        "total": str(order.total),
        "cash_received": (
            str(order.cash_received) if order.cash_received is not None else None
        ),
        "change_due": str(order.change_due),
        "seat_labels": [reservation.seat.label for reservation in seats],
        "ticket_ids": list(
            order.issued_tickets.order_by("issued_at", "id").values_list("id", flat=True)
        ),
    }


def serialize_check_in_ticket(ticket: IssuedTicket) -> dict[str, object]:
    assignment = (
        SeatReservation.objects.select_related("seat")
        .filter(
            issued_ticket=ticket,
            status=SeatReservation.Status.CONFIRMED,
        )
        .first()
    )
    return {
        "ticket_id": ticket.pk,
        "ticket_name": ticket.ticket_type.name,
        "attendee_name": ticket.order.customer_name,
        "attendee_email": ticket.order.customer_email,
        "seat_label": assignment.seat.label if assignment else None,
        "checked_in_at": (
            ticket.checked_in_at.isoformat() if ticket.checked_in_at else None
        ),
    }


def organization_event(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
) -> tuple[OrganizationMembership, Event]:
    membership = get_membership(request.user, organization_slug)
    event = get_object_or_404(
        Event.objects.filter(organization=membership.organization),
        pk=event_id,
    )
    if not can_manage_event(membership, event):
        raise HttpError(403, "Organizer permission is required for this event.")
    return membership, event


@router.get(
    "/organizations/{organization_slug}/events/{event_id}/seating",
    auth=django_auth,
    response=SeatingWorkspaceSchema,
)
def get_seating_workspace(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
) -> dict[str, object]:
    _, event = organization_event(request, organization_slug, event_id)
    return serialize_seating_workspace(event)


@router.put(
    "/organizations/{organization_slug}/events/{event_id}/seating",
    auth=django_auth,
    response=SeatingWorkspaceSchema,
)
def save_seating_workspace(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    payload: SeatMapInput,
) -> dict[str, object]:
    membership = get_membership(request.user, organization_slug)
    if membership.role == OrganizationMembership.Role.VIEWER:
        raise HttpError(403, "Organizer permission is required to edit seating.")
    with transaction.atomic():
        event = get_object_or_404(
            Event.objects.select_for_update().filter(
                organization=membership.organization
            ),
            pk=event_id,
        )
        if not can_manage_event(membership, event):
            raise HttpError(403, "Organizer permission is required for this event.")

        zone_keys = {zone.key for zone in payload.zones}
        zone_ticket_ids = {zone.ticket_type_id for zone in payload.zones}
        tickets = {
            ticket.pk: ticket
            for ticket in TicketType.objects.select_for_update().filter(
                event=event,
                active=True,
                pk__in=zone_ticket_ids,
            )
        }
        if zone_ticket_ids != set(tickets):
            raise HttpError(400, "Every seating zone must use an active event ticket.")
        seat_counts: dict[int, int] = {}
        zone_tickets = {
            zone.key: zone.ticket_type_id
            for zone in payload.zones
        }
        for seat in payload.seats:
            if seat.zone_key not in zone_keys:
                raise HttpError(400, "A seat refers to an unknown zone.")
            ticket_id = zone_tickets[seat.zone_key]
            seat_counts[ticket_id] = seat_counts.get(ticket_id, 0) + 1
        if any(tickets[ticket_id].capacity != count for ticket_id, count in seat_counts.items()):
            raise HttpError(
                400,
                "Each reserved-seat ticket capacity must match the number of seats in its zones.",
            )
        if set(seat_counts) != zone_ticket_ids:
            raise HttpError(400, "Every seating zone must contain at least one seat.")
        if any(tickets[ticket_id].sold for ticket_id in zone_ticket_ids):
            raise HttpError(409, "Configure reserved seating before selling tickets.")
        if OrderItem.objects.filter(
            ticket_type_id__in=zone_ticket_ids,
            order__status=Order.Status.PENDING,
        ).exists():
            raise HttpError(409, "Reserved-seat tickets already have active orders.")

        seat_map, _ = SeatMap.objects.select_for_update().get_or_create(event=event)
        if SeatReservation.objects.filter(
            seat__seat_map=seat_map,
            status__in=[
                SeatReservation.Status.HELD,
                SeatReservation.Status.CONFIRMED,
            ],
        ).exists():
            raise HttpError(409, "Release or complete active seat assignments before editing.")

        SeatReservation.objects.filter(seat__seat_map=seat_map).delete()
        seat_map.seats.all().delete()
        seat_map.zones.all().delete()
        seat_map.width = payload.width
        seat_map.height = payload.height
        seat_map.save(update_fields=["width", "height", "updated_at"])

        zones = {}
        for zone in payload.zones:
            zones[zone.key] = SeatZone.objects.create(
                seat_map=seat_map,
                key=zone.key,
                name=zone.name,
                color=zone.color,
                ticket_type=tickets[zone.ticket_type_id],
            )
        Seat.objects.bulk_create(
            [
                Seat(
                    seat_map=seat_map,
                    zone=zones[seat.zone_key],
                    label=seat.label,
                    row_label=seat.row,
                    seat_number=seat.number,
                    x=seat.x,
                    y=seat.y,
                    blocked=seat.blocked,
                )
                for seat in payload.seats
            ]
        )
    return serialize_seating_workspace(event)


@router.post(
    "/organizations/{organization_slug}/events/{event_id}/box-office/orders",
    auth=django_auth,
    response=BoxOfficeSaleSchema,
    tags=["Box Office"],
)
def create_box_office_sale(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    payload: BoxOfficeSaleInput,
) -> dict[str, object]:
    _, authorized_event = organization_event(request, organization_slug, event_id)
    now = timezone.now()
    with transaction.atomic():
        event = Event.objects.select_for_update().get(pk=authorized_event.pk)
        if event.status != Event.Status.PUBLISHED:
            raise HttpError(409, "Only published events can sell tickets at the door.")
        existing = (
            Order.objects.select_for_update()
            .filter(event=event, idempotency_key=payload.idempotency_key)
            .first()
        )
        if existing:
            item = existing.items.first()
            stored_seats = list(
                SeatReservation.objects.filter(order_item=item)
                .order_by("seat_id")
                .values_list("seat_id", flat=True)
            ) if item else []
            if (
                item is None
                or item.ticket_type_id != payload.ticket_type_id
                or item.quantity != payload.quantity
                or existing.customer_name != payload.customer_name
                or existing.payment_method != payload.payment_method
                or existing.cash_received != payload.cash_received
                or (
                    payload.price_tier_id is not None
                    and item.price_tier_id != payload.price_tier_id
                )
                or (
                    payload.customer_email is not None
                    and existing.customer_email != payload.customer_email
                )
                or stored_seats != sorted(payload.seat_ids)
            ):
                raise HttpError(409, "This box-office idempotency key was already used.")
            return serialize_box_office_sale(existing)

        ticket = get_object_or_404(
            TicketType.objects.select_for_update().filter(
                event=event,
                active=True,
                hidden=False,
            ),
            pk=payload.ticket_type_id,
        )
        active_quantity = (
            OrderItem.objects.filter(
                ticket_type=ticket,
                order__status=Order.Status.PENDING,
                order__expires_at__gt=now,
            ).aggregate(quantity=Sum("quantity"))["quantity"]
            or 0
        )
        if ticket.sold + active_quantity + payload.quantity > ticket.capacity:
            raise HttpError(409, "Not enough tickets remain for this sale.")

        tiers = list(
            TicketPriceTier.objects.select_for_update()
            .filter(ticket_type=ticket)
            .annotate(
                _held=Sum(
                    "order_items__quantity",
                    filter=Q(
                        order_items__order__status=Order.Status.PENDING,
                        order_items__order__expires_at__gt=now,
                    ),
                )
            )
            .order_by("position", "id")
        )
        price_tier = None
        if tiers:
            price_tier = next(
                (
                    tier
                    for tier in tiers
                    if tier.capacity - tier.sold - (tier._held or 0) >= payload.quantity
                ),
                None,
            )
            if price_tier is None:
                raise HttpError(409, "Not enough tickets remain at an available price tier.")
            if payload.price_tier_id and payload.price_tier_id != price_tier.pk:
                raise HttpError(409, "The selected price tier is no longer available.")
        elif payload.price_tier_id is not None:
            raise HttpError(404, "Price tier not found.")

        try:
            seats = select_available_seats(
                ticket,
                payload.seat_ids,
                payload.quantity,
                at=now,
            )
        except SeatSelectionError as exc:
            raise HttpError(exc.status_code, str(exc)) from exc

        unit_price = price_tier.price if price_tier else ticket.price
        subtotal = unit_price * payload.quantity
        discount = subtotal if payload.payment_method == "comp" else Decimal("0.00")
        total = subtotal - discount
        cash_received = payload.cash_received
        if payload.payment_method == "cash":
            if cash_received is None or cash_received < total:
                raise HttpError(400, "Cash received must cover the amount due.")
        elif cash_received is not None:
            raise HttpError(400, "Cash received is only valid for cash payments.")
        order_id = uuid.uuid4()
        order = Order.objects.create(
            id=order_id,
            event=event,
            channel=Order.Channel.BOX_OFFICE,
            payment_method=payload.payment_method,
            cash_received=cash_received,
            change_due=(
                cash_received - total
                if cash_received is not None
                else Decimal("0.00")
            ),
            created_by=request.user,
            customer_name=payload.customer_name,
            customer_email=(
                payload.customer_email
                or f"walkup-{order_id.hex}@walkup.eventflow.invalid"
            ),
            idempotency_key=payload.idempotency_key,
            currency="USD",
            subtotal=subtotal,
            discount_amount=discount,
            fees=Decimal("0.00"),
            total=total,
            expires_at=now + timedelta(minutes=10),
        )
        item = OrderItem.objects.create(
            order=order,
            ticket_type=ticket,
            price_tier=price_tier,
            quantity=payload.quantity,
            unit_price=unit_price,
        )
        SeatReservation.objects.bulk_create(
            [
                SeatReservation(seat=seat, order_item=item)
                for seat in seats
            ]
        )
        issue_reserved_tickets(order, [item], increment_sold=True)
        order.status = Order.Status.CONFIRMED
        order.save(update_fields=["status"])
    return serialize_box_office_sale(order)


@router.get(
    "/organizations/{organization_slug}/events/{event_id}/check-in/search",
    auth=django_auth,
    response=CheckInSearchSchema,
    tags=["Check-in"],
)
def search_check_in_tickets(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    q: str = "",
) -> dict[str, object]:
    _, event = organization_event(request, organization_slug, event_id)
    query = q.strip()
    if len(query) > 100:
        raise HttpError(400, "Search text must be 100 characters or fewer.")
    tickets = IssuedTicket.objects.filter(
        order__event=event,
        order__status=Order.Status.CONFIRMED,
    ).select_related(
        "order",
        "ticket_type",
    )
    if query:
        search_filter = (
            Q(order__customer_name__icontains=query)
            | Q(order__customer_email__icontains=query)
            | Q(ticket_type__name__icontains=query)
        )
        try:
            search_filter |= Q(pk=uuid.UUID(query))
        except ValueError:
            pass
        tickets = tickets.filter(search_filter)
    total = tickets.count()
    return {
        "tickets": [
            serialize_check_in_ticket(ticket)
            for ticket in tickets.order_by("-issued_at", "id")[:50]
        ],
        "total": total,
    }


@router.post(
    "/organizations/{organization_slug}/events/{event_id}/check-in/sync",
    auth=django_auth,
    response=CheckInSyncSchema,
    tags=["Check-in"],
)
def sync_check_in_tickets(
    request: HttpRequest,
    organization_slug: str,
    event_id: int,
    payload: CheckInSyncInput,
) -> dict[str, object]:
    _, event = organization_event(request, organization_slug, event_id)
    results = []
    now = timezone.now()
    with transaction.atomic():
        for ticket_id in payload.ticket_ids:
            ticket = (
                IssuedTicket.objects.select_for_update()
                .filter(
                    pk=ticket_id,
                    order__event=event,
                    order__status=Order.Status.CONFIRMED,
                )
                .select_related("order", "ticket_type")
                .first()
            )
            if ticket is None:
                results.append(
                    {
                        "ticket_id": ticket_id,
                        "status": "invalid",
                        "ticket_name": None,
                        "attendee_name": None,
                        "seat_label": None,
                        "checked_in_at": None,
                    }
                )
                continue
            status = "already_checked_in"
            if ticket.checked_in_at is None:
                ticket.checked_in_at = now
                ticket.checked_in_by = request.user
                ticket.save(update_fields=["checked_in_at", "checked_in_by"])
                status = "checked_in"
            assignment = (
                SeatReservation.objects.select_related("seat")
                .filter(
                    issued_ticket=ticket,
                    status=SeatReservation.Status.CONFIRMED,
                )
                .first()
            )
            results.append(
                {
                    "ticket_id": ticket.pk,
                    "status": status,
                    "ticket_name": ticket.ticket_type.name,
                    "attendee_name": ticket.order.customer_name,
                    "seat_label": assignment.seat.label if assignment else None,
                    "checked_in_at": ticket.checked_in_at.isoformat(),
                }
            )
    return {"results": results}
