import uuid
from datetime import timedelta
from decimal import Decimal, ROUND_HALF_UP

from django.core.cache import cache
from django.core.exceptions import ValidationError as DjangoValidationError
from django.core.validators import validate_email
from django.conf import settings
from django.db import transaction
from django.db.models import Exists, IntegerField, OuterRef, Prefetch, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import NinjaAPI, Schema, Status
from ninja.errors import HttpError
from pydantic import Field, field_validator
import stripe

from catalog.models import (
    Event as EventModel,
    IssuedTicket,
    Order,
    OrderItem,
    PromotionCode,
    SeatMap,
    SeatReservation,
    TicketPriceTier,
    TicketType,
    WaitlistEntry,
)
from catalog.organizations import router as organizations_router
from catalog.payments import (
    CheckoutSessionUnavailable,
    OrderNotPayable,
    WebhookRetry,
    create_checkout_session,
    process_checkout_session,
)
from catalog.tickets import ticket_pdf
from catalog.seating import (
    public_seat_map,
    select_available_seats,
    SeatSelectionError,
)

RESERVATION_TTL = timedelta(minutes=10)
RESERVATION_RATE_LIMIT = 20
RESERVATION_RATE_WINDOW_SECONDS = 60
WAITLIST_OFFER_TTL = timedelta(minutes=15)

api = NinjaAPI(
    title="EventFlow API",
    description="REST API for the EventFlow event and ticketing platform.",
    version="0.1.0",
    urls_namespace="eventflow_api",
)


@api.get("/health", tags=["System"])
def health(request) -> dict[str, str]:
    return {"status": "ok", "service": "eventflow-api"}


class PriceTierSchema(Schema):
    id: int
    name: str
    price: str
    capacity: int
    remaining: int


class TicketSchema(Schema):
    id: int
    name: str
    description: str
    price: str
    capacity: int
    remaining: int
    price_tiers: list[PriceTierSchema]


class EventSeriesDateSchema(Schema):
    id: int
    slug: str
    starts_at: str


class EventSchema(Schema):
    id: int
    title: str
    slug: str
    description: str
    starts_at: str
    venue: str
    status: str
    tickets: list[TicketSchema]
    series_id: int | None
    series_dates: list[EventSeriesDateSchema]
    has_hidden_tickets: bool
    has_seating: bool


class PublicSeatZoneSchema(Schema):
    key: str
    name: str
    color: str
    ticket_type_id: int
    ticket_name: str
    price: str


class PublicSeatSchema(Schema):
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


class PublicSeatMapSchema(Schema):
    width: int
    height: int
    zones: list[PublicSeatZoneSchema]
    seats: list[PublicSeatSchema]


class ReservationInput(Schema):
    ticket_type_id: int
    quantity: int
    customer_name: str
    customer_email: str
    idempotency_key: uuid.UUID
    price_tier_id: int | None = None
    promo_code: str | None = None
    seat_ids: list[int] = Field(default_factory=list)

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, value: int) -> int:
        if not 1 <= value <= 6:
            raise ValueError("Quantity must be between 1 and 6.")
        return value

    @field_validator("customer_name")
    @classmethod
    def normalize_customer_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 180:
            raise ValueError("Name must contain 1 to 180 characters.")
        return name

    @field_validator("customer_email")
    @classmethod
    def normalize_customer_email(cls, value: str) -> str:
        email = value.strip().lower()
        try:
            validate_email(email)
        except DjangoValidationError as exc:
            raise ValueError("Enter a valid email address.") from exc
        return email

    @field_validator("promo_code")
    @classmethod
    def normalize_promo_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        code = value.strip().upper()
        if not code:
            return None
        if len(code) > 64:
            raise ValueError("Promotion code must be 64 characters or fewer.")
        return code

    @field_validator("seat_ids")
    @classmethod
    def validate_seat_ids(cls, value: list[int]) -> list[int]:
        if len(value) > 6 or len(value) != len(set(value)):
            raise ValueError("Choose up to 6 distinct seats.")
        return value


class ReservationSchema(Schema):
    id: uuid.UUID
    event_slug: str
    ticket_type_id: int
    ticket_name: str
    quantity: int
    status: str
    currency: str
    subtotal: str
    discount_amount: str
    fees: str
    total: str
    expires_at: str
    price_tier_id: int | None
    promo_code: str | None
    seat_labels: list[str]


class PromotionValidationInput(Schema):
    code: str
    ticket_type_id: int | None = None
    price_tier_id: int | None = None
    quantity: int = 1

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        code = value.strip().upper()
        if not code or len(code) > 64:
            raise ValueError("Enter a valid promotion code.")
        return code

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, value: int) -> int:
        if not 1 <= value <= 6:
            raise ValueError("Quantity must be between 1 and 6.")
        return value


class PromotionValidationSchema(Schema):
    code: str
    discount_type: str
    value: str
    discount_amount: str
    revealed_tickets: list[TicketSchema]


class CheckoutSessionSchema(Schema):
    order_id: uuid.UUID
    checkout_url: str


class PaymentConfigSchema(Schema):
    stripe_enabled: bool


class IssuedTicketSchema(Schema):
    id: uuid.UUID
    ticket_name: str
    pdf_url: str
    seat_label: str | None
    checked_in_at: str | None


class OrderDetailSchema(Schema):
    id: uuid.UUID
    event_slug: str
    event_title: str
    status: str
    currency: str
    total: str
    tickets: list[IssuedTicketSchema]


class WaitlistInput(Schema):
    ticket_type_id: int
    quantity: int
    customer_name: str
    customer_email: str

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, value: int) -> int:
        if not 1 <= value <= 6:
            raise ValueError("Quantity must be between 1 and 6.")
        return value

    @field_validator("customer_name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        name = value.strip()
        if not name or len(name) > 180:
            raise ValueError("Name must contain 1 to 180 characters.")
        return name

    @field_validator("customer_email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        email = value.strip().lower()
        try:
            validate_email(email)
        except DjangoValidationError as exc:
            raise ValueError("Enter a valid email address.") from exc
        return email


class WaitlistStatusSchema(Schema):
    token: uuid.UUID
    event_title: str
    ticket_name: str
    status: str
    quantity: int
    order_id: uuid.UUID | None
    offer_expires_at: str | None
    total: str | None


def public_price_tiers():
    active_reservations = Q(
        order_items__order__status=Order.Status.PENDING,
        order_items__order__expires_at__gt=timezone.now(),
    )
    return TicketPriceTier.objects.annotate(
        _reserved_quantity=Coalesce(
            Sum("order_items__quantity", filter=active_reservations),
            Value(0),
            output_field=IntegerField(),
        )
    )


def public_ticket_types(*, include_hidden: bool = False):
    active_reservations = Q(
        order_items__order__status=Order.Status.PENDING,
        order_items__order__expires_at__gt=timezone.now(),
    )
    tickets = TicketType.objects.filter(active=True)
    if not include_hidden:
        tickets = tickets.filter(hidden=False)
    return tickets.annotate(
        _reserved_quantity=Coalesce(
            Sum("order_items__quantity", filter=active_reservations),
            Value(0),
            output_field=IntegerField(),
        )
    ).prefetch_related(Prefetch("price_tiers", queryset=public_price_tiers()))


def public_events(*, include_series_dates: bool = False):
    hidden_tickets = TicketType.objects.filter(
        event_id=OuterRef("pk"),
        active=True,
        hidden=True,
    )
    published_series_events = EventModel.objects.filter(
        status=EventModel.Status.PUBLISHED
    ).only("id", "slug", "starts_at", "series_id")
    seat_maps = SeatMap.objects.filter(event_id=OuterRef("pk"))
    events = (
        EventModel.objects.filter(status=EventModel.Status.PUBLISHED)
        .select_related("series")
        .annotate(has_hidden_tickets=Exists(hidden_tickets))
        .annotate(has_seating=Exists(seat_maps))
        .prefetch_related(Prefetch("ticket_types", queryset=public_ticket_types()))
    )
    if include_series_dates:
        events = events.prefetch_related(
            Prefetch(
                "series__events",
                queryset=published_series_events,
                to_attr="published_series_events",
            ),
        )
    return events


@api.get("/events", response=list[EventSchema], tags=["Events"])
def list_events(request) -> list[dict[str, object]]:
    return [serialize_event(event) for event in public_events()]


@api.get("/events/{slug}", response=EventSchema, tags=["Events"])
def get_event(request, slug: str) -> dict[str, object]:
    event = get_object_or_404(
        public_events(include_series_dates=True),
        slug=slug,
    )
    return serialize_event(event, include_series_dates=True)


@api.get(
    "/events/{slug}/seating",
    response=PublicSeatMapSchema,
    tags=["Seating"],
)
def get_public_event_seating(request, slug: str) -> dict[str, object]:
    event = get_object_or_404(
        EventModel.objects.filter(status=EventModel.Status.PUBLISHED),
        slug=slug,
    )
    seat_map = public_seat_map(event)
    if seat_map is None:
        raise HttpError(404, "This event does not have a reserved seating map.")
    return seat_map


def available_price_tiers(
    ticket: TicketType,
    now=None,
) -> list[TicketPriceTier]:
    at = now or timezone.now()
    active_reservations = Q(
        order_items__order__status=Order.Status.PENDING,
        order_items__order__expires_at__gt=at,
    )
    return list(
        TicketPriceTier.objects.filter(ticket_type=ticket)
        .annotate(
            _reserved_quantity=Coalesce(
                Sum("order_items__quantity", filter=active_reservations),
                Value(0),
                output_field=IntegerField(),
            )
        )
        .order_by("position", "id")
    )


def valid_promotion(
    event: EventModel,
    code: str,
    *,
    now=None,
    lock: bool = False,
) -> PromotionCode:
    at = now or timezone.now()
    promotions = PromotionCode.objects.filter(event=event, code=code)
    if lock:
        promotions = promotions.select_for_update()
    promotion = promotions.first()
    if (
        promotion is None
        or not promotion.active
        or (promotion.starts_at is not None and promotion.starts_at > at)
        or (promotion.expires_at is not None and promotion.expires_at <= at)
    ):
        raise HttpError(400, "This promotion code is not valid.")
    if promotion.max_uses is not None:
        active_reservations = Order.objects.filter(
            promotion=promotion,
            status=Order.Status.PENDING,
            expires_at__gt=at,
        ).count()
        if promotion.used_count + active_reservations >= promotion.max_uses:
            raise HttpError(400, "This promotion code has reached its usage limit.")
    return promotion


def promotion_discount(
    promotion: PromotionCode,
    subtotal: Decimal,
) -> Decimal:
    if subtotal <= 0:
        return Decimal("0.00")
    if promotion.discount_type == PromotionCode.DiscountType.PERCENT:
        discount = (subtotal * promotion.value / Decimal("100")).quantize(
            Decimal("0.01"),
            rounding=ROUND_HALF_UP,
        )
    else:
        discount = min(subtotal, promotion.value)
    return min(subtotal, discount)


def serialize_hidden_tickets(event: EventModel) -> list[dict[str, object]]:
    tickets = public_ticket_types(include_hidden=True).filter(
        event=event,
        hidden=True,
    )
    return [serialize_ticket(ticket) for ticket in tickets]


@api.post(
    "/events/{slug}/promotions/validate",
    response=PromotionValidationSchema,
    tags=["Promotions"],
)
def validate_event_promotion(
    request,
    slug: str,
    payload: PromotionValidationInput,
) -> dict[str, object]:
    event = get_object_or_404(
        EventModel.objects.filter(status=EventModel.Status.PUBLISHED),
        slug=slug,
    )
    promotion = valid_promotion(event, payload.code)
    discount_amount = Decimal("0.00")
    if payload.ticket_type_id is not None:
        ticket = get_object_or_404(
            TicketType.objects.filter(event=event, active=True),
            pk=payload.ticket_type_id,
        )
        if ticket.hidden and not promotion.reveals_hidden_tickets:
            raise HttpError(400, "This code does not unlock that ticket.")
        if promotion.ticket_type_id and promotion.ticket_type_id != ticket.id:
            raise HttpError(400, "This code does not apply to that ticket.")
        tiers = available_price_tiers(ticket)
        if tiers:
            eligible_tiers = [
                tier for tier in tiers if tier.remaining >= payload.quantity
            ]
            if not eligible_tiers:
                raise HttpError(
                    409,
                    "Not enough tickets remain at an available price tier.",
                )
            tier = eligible_tiers[0]
            if payload.price_tier_id and payload.price_tier_id != tier.id:
                raise HttpError(
                    409,
                    "The selected price tier is no longer available. Refresh the event.",
                )
            price = tier.price
        elif payload.price_tier_id is not None:
            raise HttpError(404, "Price tier not found.")
        else:
            price = ticket.price
        discount_amount = promotion_discount(
            promotion,
            price * payload.quantity,
        )
    return {
        "code": promotion.code,
        "discount_type": promotion.discount_type,
        "value": str(promotion.value),
        "discount_amount": str(discount_amount),
        "revealed_tickets": (
            serialize_hidden_tickets(event)
            if promotion.reveals_hidden_tickets
            else []
        ),
    }


@api.post(
    "/events/{slug}/reservations",
    response={200: ReservationSchema, 201: ReservationSchema},
    tags=["Reservations"],
)
def create_reservation(
    request,
    slug: str,
    payload: ReservationInput,
) -> Status[ReservationSchema]:
    enforce_reservation_rate_limit(request)
    now = timezone.now()

    with transaction.atomic():
        event = (
            EventModel.objects.select_for_update()
            .filter(slug=slug, status=EventModel.Status.PUBLISHED)
            .first()
        )
        if event is None:
            raise HttpError(404, "Published event not found.")

        order = (
            Order.objects.select_for_update()
            .filter(event=event, idempotency_key=payload.idempotency_key)
            .prefetch_related("items__ticket_type", "items__price_tier")
            .first()
        )
        if order is not None:
            item = order.items.first()
            stored_code = (
                PromotionCode.objects.filter(pk=order.promotion_id)
                .values_list("code", flat=True)
                .first()
                if order.promotion_id
                else None
            )
            stored_seat_ids = (
                list(
                    SeatReservation.objects.filter(order_item=item)
                    .order_by("seat_id")
                    .values_list("seat_id", flat=True)
                )
                if item
                else []
            )
            if (
                item is None
                or order.customer_name != payload.customer_name
                or order.customer_email != payload.customer_email
                or item.ticket_type_id != payload.ticket_type_id
                or item.quantity != payload.quantity
                or (
                    payload.price_tier_id is not None
                    and item.price_tier_id != payload.price_tier_id
                )
                or stored_code != payload.promo_code
                or stored_seat_ids != sorted(payload.seat_ids)
            ):
                raise HttpError(409, "Idempotency key was already used for another order.")
            return Status(200, serialize_reservation(order, item))

        promotion = (
            valid_promotion(event, payload.promo_code, now=now, lock=True)
            if payload.promo_code
            else None
        )
        ticket = (
            TicketType.objects.select_for_update()
            .filter(event=event, id=payload.ticket_type_id, active=True)
            .first()
        )
        if ticket is None:
            raise HttpError(404, "Active ticket type not found.")

        active_quantity = (
            OrderItem.objects.filter(
                ticket_type=ticket,
                order__status=Order.Status.PENDING,
                order__expires_at__gt=now,
            ).aggregate(quantity=Sum("quantity"))["quantity"]
            or 0
        )
        available = max(0, ticket.capacity - ticket.sold - active_quantity)
        if payload.quantity > available:
            raise HttpError(409, "Not enough tickets remain for this quantity.")

        if ticket.hidden and not (
            promotion and promotion.reveals_hidden_tickets
        ):
            raise HttpError(404, "Active ticket type not found.")
        if (
            promotion
            and promotion.ticket_type_id
            and promotion.ticket_type_id != ticket.id
        ):
            raise HttpError(400, "This promotion code does not apply to that ticket.")

        price_tiers = available_price_tiers(ticket, now)
        price_tier = None
        if price_tiers:
            eligible_tiers = [
                tier for tier in price_tiers if tier.remaining >= payload.quantity
            ]
            if not eligible_tiers:
                raise HttpError(409, "Not enough tickets remain at an available price tier.")
            price_tier = eligible_tiers[0]
            if payload.price_tier_id and payload.price_tier_id != price_tier.id:
                raise HttpError(
                    409,
                    "The selected price tier is no longer available. Refresh the event.",
                )
        elif payload.price_tier_id is not None:
            raise HttpError(404, "Price tier not found.")

        try:
            selected_seats = select_available_seats(
                ticket,
                payload.seat_ids,
                payload.quantity,
                at=now,
            )
        except SeatSelectionError as exc:
            raise HttpError(exc.status_code, str(exc)) from exc

        unit_price = price_tier.price if price_tier else ticket.price
        subtotal = unit_price * payload.quantity
        discount_amount = (
            promotion_discount(promotion, subtotal)
            if promotion
            else Decimal("0.00")
        )
        fees = Decimal("0.00")
        order = Order.objects.create(
            event=event,
            customer_name=payload.customer_name,
            customer_email=payload.customer_email,
            idempotency_key=payload.idempotency_key,
            currency="USD",
            subtotal=subtotal,
            discount_amount=discount_amount,
            fees=fees,
            total=subtotal - discount_amount + fees,
            promotion=promotion,
            expires_at=now + RESERVATION_TTL,
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
                SeatReservation(
                    seat=seat,
                    order_item=item,
                )
                for seat in selected_seats
            ]
        )

    return Status(201, serialize_reservation(order, item))


def offer_waitlist_for_ticket(ticket_type_id: int, now=None) -> int:
    at = now or timezone.now()
    event_id = TicketType.objects.filter(pk=ticket_type_id).values_list(
        "event_id",
        flat=True,
    ).first()
    if event_id is None:
        return 0

    offered_count = 0
    with transaction.atomic():
        EventModel.objects.select_for_update().get(pk=event_id)
        ticket = TicketType.objects.select_for_update().get(pk=ticket_type_id)
        expired_entries = list(
            WaitlistEntry.objects.select_for_update()
            .filter(
                ticket_type=ticket,
                status=WaitlistEntry.Status.OFFERED,
                offer_expires_at__lte=at,
            )
        )
        for entry in expired_entries:
            if entry.order_id:
                entry_order = (
                    Order.objects.select_for_update()
                    .filter(pk=entry.order_id)
                    .first()
                )
                if entry_order and entry_order.status == Order.Status.PENDING:
                    entry_order.status = Order.Status.EXPIRED
                    entry_order.save(update_fields=["status"])
            entry.status = WaitlistEntry.Status.EXPIRED
            entry.save(update_fields=["status"])

        active_quantity = (
            OrderItem.objects.filter(
                ticket_type=ticket,
                order__status=Order.Status.PENDING,
                order__expires_at__gt=at,
            ).aggregate(quantity=Sum("quantity"))["quantity"]
            or 0
        )
        available = max(0, ticket.capacity - ticket.sold - active_quantity)
        waiting_entries = list(
            WaitlistEntry.objects.select_for_update()
            .filter(ticket_type=ticket, status=WaitlistEntry.Status.WAITING)
            .order_by("created_at", "id")
        )
        for entry in waiting_entries:
            if entry.quantity > available:
                continue
            price_tier = next(
                (
                    tier
                    for tier in available_price_tiers(ticket, at)
                    if tier.remaining >= entry.quantity
                ),
                None,
            )
            has_price_tiers = TicketPriceTier.objects.filter(
                ticket_type=ticket
            ).exists()
            if has_price_tiers and price_tier is None:
                continue

            unit_price = price_tier.price if price_tier else ticket.price
            subtotal = unit_price * entry.quantity
            expires_at = at + WAITLIST_OFFER_TTL
            order = Order.objects.create(
                event_id=event_id,
                customer_name=entry.customer_name,
                customer_email=entry.customer_email,
                idempotency_key=uuid.uuid4(),
                currency="USD",
                subtotal=subtotal,
                discount_amount=Decimal("0.00"),
                fees=Decimal("0.00"),
                total=subtotal,
                expires_at=expires_at,
            )
            OrderItem.objects.create(
                order=order,
                ticket_type=ticket,
                price_tier=price_tier,
                quantity=entry.quantity,
                unit_price=unit_price,
            )
            entry.status = WaitlistEntry.Status.OFFERED
            entry.offered_at = at
            entry.offer_expires_at = expires_at
            entry.order = order
            entry.save(
                update_fields=[
                    "status",
                    "offered_at",
                    "offer_expires_at",
                    "order",
                ]
            )
            available -= entry.quantity
            offered_count += 1
            if not available:
                break
    return offered_count


@api.post(
    "/events/{slug}/waitlist",
    response=WaitlistStatusSchema,
    tags=["Waitlist"],
)
def join_waitlist(
    request,
    slug: str,
    payload: WaitlistInput,
) -> dict[str, object]:
    enforce_reservation_rate_limit(request)
    with transaction.atomic():
        event = (
            EventModel.objects.select_for_update()
            .filter(slug=slug, status=EventModel.Status.PUBLISHED)
            .first()
        )
        if event is None:
            raise HttpError(404, "Published event not found.")
        ticket = (
            TicketType.objects.select_for_update()
            .filter(event=event, pk=payload.ticket_type_id, active=True, hidden=False)
            .first()
        )
        if ticket is None:
            raise HttpError(404, "Active ticket type not found.")

        if WaitlistEntry.objects.filter(
            event=event,
            ticket_type=ticket,
            customer_email=payload.customer_email,
            status__in=[WaitlistEntry.Status.WAITING, WaitlistEntry.Status.OFFERED],
        ).exists():
            raise HttpError(409, "This email address is already on the waitlist.")

        ticket_available = ticket.remaining >= payload.quantity
        tiers = available_price_tiers(ticket)
        tier_available = not tiers or any(
            tier.remaining >= payload.quantity for tier in tiers
        )
        if ticket_available and tier_available:
            raise HttpError(409, "Tickets are available. Continue to checkout instead.")
        entry = WaitlistEntry.objects.create(
            event=event,
            ticket_type=ticket,
            customer_name=payload.customer_name,
            customer_email=payload.customer_email,
            quantity=payload.quantity,
        )
    return serialize_waitlist_entry(entry)


@api.get(
    "/waitlist/{token}",
    response=WaitlistStatusSchema,
    tags=["Waitlist"],
)
def get_waitlist_entry(request, token: uuid.UUID) -> dict[str, object]:
    entry = get_object_or_404(
        WaitlistEntry.objects.select_related("event", "ticket_type", "order"),
        token=token,
    )
    if (
        entry.status == WaitlistEntry.Status.OFFERED
        and entry.offer_expires_at is not None
        and entry.offer_expires_at <= timezone.now()
    ):
        offer_waitlist_for_ticket(entry.ticket_type_id)
        entry.refresh_from_db()
        entry.order = (
            Order.objects.filter(pk=entry.order_id).first()
            if entry.order_id
            else None
        )
    return serialize_waitlist_entry(entry)


@api.post(
    "/waitlist/{token}/checkout-session",
    response=CheckoutSessionSchema,
    tags=["Waitlist", "Payments"],
)
def begin_waitlist_checkout(request, token: uuid.UUID) -> dict[str, object]:
    entry = get_object_or_404(
        WaitlistEntry.objects.select_related("order"),
        token=token,
        status=WaitlistEntry.Status.OFFERED,
    )
    if (
        entry.offer_expires_at is None
        or entry.offer_expires_at <= timezone.now()
        or entry.order is None
        or entry.order.status != Order.Status.PENDING
    ):
        raise HttpError(409, "This ticket offer has expired.")
    if entry.order.total > 0 and not settings.STRIPE_SECRET_KEY:
        raise HttpError(503, "Stripe payments are not configured.")
    try:
        checkout_url = create_checkout_session(entry.order_id)
    except OrderNotPayable as exc:
        raise HttpError(409, str(exc)) from exc
    except CheckoutSessionUnavailable as exc:
        raise HttpError(502, "Stripe did not provide a checkout URL.") from exc
    except stripe.StripeError as exc:
        raise HttpError(502, "Stripe could not start the checkout.") from exc
    order = Order.objects.get(pk=entry.order_id)
    if order.status == Order.Status.CONFIRMED:
        WaitlistEntry.objects.filter(
            pk=entry.pk,
            status=WaitlistEntry.Status.OFFERED,
        ).update(status=WaitlistEntry.Status.CONVERTED)
    elif order.expires_at:
        WaitlistEntry.objects.filter(
            pk=entry.pk,
            status=WaitlistEntry.Status.OFFERED,
        ).update(offer_expires_at=order.expires_at)
    return {"order_id": entry.order_id, "checkout_url": checkout_url}


@api.post(
    "/orders/{order_id}/checkout-session",
    response=CheckoutSessionSchema,
    tags=["Payments"],
)
def begin_checkout(request, order_id: uuid.UUID) -> dict[str, object]:
    order = get_object_or_404(Order.objects.select_related("event"), pk=order_id)
    if order.total > 0 and not settings.STRIPE_SECRET_KEY:
        raise HttpError(503, "Stripe payments are not configured.")
    try:
        checkout_url = create_checkout_session(order.id)
    except OrderNotPayable as exc:
        raise HttpError(409, str(exc)) from exc
    except CheckoutSessionUnavailable as exc:
        raise HttpError(502, "Stripe did not provide a checkout URL.") from exc
    except stripe.StripeError as exc:
        raise HttpError(502, "Stripe could not start the checkout.") from exc
    return {"order_id": order.id, "checkout_url": checkout_url}


@api.get("/payments/config", response=PaymentConfigSchema, tags=["Payments"])
def payment_config(request) -> dict[str, bool]:
    return {"stripe_enabled": bool(settings.STRIPE_SECRET_KEY)}


@api.get("/orders/{order_id}", response=OrderDetailSchema, tags=["Orders"])
def get_order(request, order_id: uuid.UUID) -> dict[str, object]:
    order = get_object_or_404(
        Order.objects.select_related("event").prefetch_related(
            "issued_tickets__ticket_type"
        ),
        pk=order_id,
    )
    tickets: list[IssuedTicket] = list(order.issued_tickets.all())
    return {
        "id": order.id,
        "event_slug": order.event.slug,
        "event_title": order.event.title,
        "status": order.effective_status,
        "currency": order.currency,
        "total": str(order.total),
        "tickets": [
            serialize_issued_ticket(ticket)
            for ticket in tickets
        ],
    }


@api.get("/tickets/{ticket_id}/pdf", tags=["Tickets"])
def download_ticket_pdf(request, ticket_id: uuid.UUID) -> HttpResponse:
    ticket = get_object_or_404(
        IssuedTicket.objects.select_related(
            "order__event",
            "order",
            "ticket_type",
        ),
        pk=ticket_id,
    )
    return ticket_pdf(ticket)


@api.post("/payments/stripe/webhook", tags=["Payments"])
def stripe_webhook(request) -> dict[str, bool]:
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HttpError(503, "Stripe webhooks are not configured.")
    signature = request.META.get("HTTP_STRIPE_SIGNATURE", "")
    try:
        event = stripe.Webhook.construct_event(
            request.body,
            signature,
            settings.STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, stripe.SignatureVerificationError) as exc:
        raise HttpError(400, "Invalid Stripe webhook signature or payload.") from exc

    try:
        process_checkout_session(event.type, event.data.object)
    except WebhookRetry as exc:
        raise HttpError(503, str(exc)) from exc
    except stripe.StripeError as exc:
        raise HttpError(502, "Stripe payment reconciliation failed.") from exc
    return {"received": True}


def enforce_reservation_rate_limit(request) -> None:
    address = (
        request.META.get("HTTP_X_REAL_IP")
        or request.META.get("REMOTE_ADDR")
        or "unknown"
    )[:64]
    key = f"reservation-rate:{address}"
    if cache.add(key, 1, timeout=RESERVATION_RATE_WINDOW_SECONDS):
        return

    try:
        requests = cache.incr(key)
    except ValueError:
        cache.add(key, 1, timeout=RESERVATION_RATE_WINDOW_SECONDS)
        requests = 1
    if requests > RESERVATION_RATE_LIMIT:
        raise HttpError(429, "Too many reservation requests. Try again shortly.")


def serialize_reservation(order: Order, item: OrderItem) -> dict[str, object]:
    return {
        "id": order.id,
        "event_slug": order.event.slug,
        "ticket_type_id": item.ticket_type_id,
        "ticket_name": item.ticket_type.name,
        "quantity": item.quantity,
        "status": order.effective_status,
        "currency": order.currency,
        "subtotal": str(order.subtotal),
        "discount_amount": str(order.discount_amount),
        "fees": str(order.fees),
        "total": str(order.total),
        "expires_at": order.expires_at.isoformat(),
        "price_tier_id": item.price_tier_id,
        "promo_code": order.promotion.code if order.promotion_id else None,
        "seat_labels": list(
            SeatReservation.objects.filter(order_item=item)
            .select_related("seat")
            .order_by("seat__row_label", "seat__seat_number")
            .values_list("seat__label", flat=True)
        ),
    }


def serialize_issued_ticket(ticket: IssuedTicket) -> dict[str, object]:
    assignment = (
        SeatReservation.objects.select_related("seat")
        .filter(
            issued_ticket=ticket,
            status=SeatReservation.Status.CONFIRMED,
        )
        .first()
    )
    return {
        "id": ticket.id,
        "ticket_name": ticket.ticket_type.name,
        "pdf_url": f"/api/v1/tickets/{ticket.id}/pdf",
        "seat_label": assignment.seat.label if assignment else None,
        "checked_in_at": (
            ticket.checked_in_at.isoformat() if ticket.checked_in_at else None
        ),
    }


def serialize_waitlist_entry(entry: WaitlistEntry) -> dict[str, object]:
    order = entry.order
    return {
        "token": entry.token,
        "event_title": entry.event.title,
        "ticket_name": entry.ticket_type.name,
        "status": entry.status,
        "quantity": entry.quantity,
        "order_id": order.id if order else None,
        "offer_expires_at": (
            entry.offer_expires_at.isoformat()
            if entry.offer_expires_at
            else None
        ),
        "total": str(order.total) if order else None,
    }


def serialize_ticket(ticket: TicketType) -> dict[str, object]:
    return {
        "id": ticket.id,
        "name": ticket.name,
        "description": ticket.description,
        "price": str(ticket.price),
        "capacity": ticket.capacity,
        "remaining": ticket.remaining,
        "price_tiers": [
            {
                "id": tier.id,
                "name": tier.name,
                "price": str(tier.price),
                "capacity": tier.capacity,
                "remaining": tier.remaining,
            }
            for tier in ticket.price_tiers.all()
        ],
    }


def serialize_event(
    event: EventModel,
    *,
    include_series_dates: bool = False,
) -> dict[str, object]:
    series_dates = []
    if event.series_id and include_series_dates:
        series_dates = [
            {
                "id": sibling.id,
                "slug": sibling.slug,
                "starts_at": sibling.starts_at.isoformat(),
            }
            for sibling in getattr(
                event.series,
                "published_series_events",
                [],
            )
        ]
    return {
        "id": event.id,
        "title": event.title,
        "slug": event.slug,
        "description": event.description,
        "starts_at": event.starts_at.isoformat(),
        "venue": event.venue,
        "status": event.status,
        "tickets": [
            serialize_ticket(ticket)
            for ticket in event.ticket_types.all()
        ],
        "series_id": event.series_id,
        "series_dates": series_dates,
        "has_hidden_tickets": bool(
            getattr(event, "has_hidden_tickets", False)
        ),
        "has_seating": bool(getattr(event, "has_seating", False)),
    }


api.add_router("", organizations_router)
