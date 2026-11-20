import uuid
from decimal import Decimal

from django.conf import settings
from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import F, Q, Sum
from django.utils import timezone
from django.utils.text import slugify


class Organization(models.Model):
    name = models.CharField(max_length=180)
    slug = models.SlugField(max_length=200, unique=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="created_organizations",
        on_delete=models.PROTECT,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name", "id"]

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.slug:
            base_slug = slugify(self.name)[:180] or "workspace"
            self.slug = base_slug
            if Organization.objects.filter(slug=self.slug).exists():
                self.slug = f"{base_slug}-{uuid.uuid4().hex[:8]}"
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.name


class OrganizationMembership(models.Model):
    class Role(models.TextChoices):
        ADMIN = "admin", "Admin"
        ORGANIZER = "organizer", "Organizer"
        VIEWER = "viewer", "Viewer"

    organization = models.ForeignKey(
        Organization,
        related_name="memberships",
        on_delete=models.CASCADE,
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="organization_memberships",
        on_delete=models.CASCADE,
    )
    role = models.CharField(
        max_length=20,
        choices=Role.choices,
        default=Role.VIEWER,
    )
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["joined_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["organization", "user"],
                name="unique_organization_membership",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user} — {self.organization} ({self.role})"


class RecurringEventSeries(models.Model):
    organization = models.ForeignKey(
        Organization,
        related_name="event_series",
        on_delete=models.CASCADE,
    )
    title = models.CharField(max_length=180)
    description = models.TextField(blank=True)
    venue = models.CharField(max_length=240)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        verbose_name_plural = "recurring event series"

    def __str__(self) -> str:
        return self.title


class OrganizationInvitation(models.Model):
    class Role(models.TextChoices):
        ORGANIZER = OrganizationMembership.Role.ORGANIZER.value, "Organizer"
        VIEWER = OrganizationMembership.Role.VIEWER.value, "Viewer"

    organization = models.ForeignKey(
        Organization,
        related_name="invitations",
        on_delete=models.CASCADE,
    )
    email = models.EmailField()
    role = models.CharField(max_length=20, choices=Role.choices)
    token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    invited_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="sent_organization_invitations",
        on_delete=models.PROTECT,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    accepted_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.email} — {self.organization}"


class EventAccess(models.Model):
    class Role(models.TextChoices):
        ORGANIZER = OrganizationMembership.Role.ORGANIZER.value, "Organizer"
        VIEWER = OrganizationMembership.Role.VIEWER.value, "Viewer"

    membership = models.ForeignKey(
        OrganizationMembership,
        related_name="event_accesses",
        on_delete=models.CASCADE,
    )
    event = models.ForeignKey(
        "Event",
        related_name="member_accesses",
        on_delete=models.CASCADE,
    )
    role = models.CharField(max_length=20, choices=Role.choices)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["membership", "event"],
                name="unique_event_access_per_member",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.membership} — {self.event} ({self.role})"


class Event(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PUBLISHED = "published", "Published"
        CANCELLED = "cancelled", "Cancelled"

    title = models.CharField(max_length=180)
    slug = models.SlugField(max_length=200, unique=True)
    organization = models.ForeignKey(
        Organization,
        related_name="events",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )
    series = models.ForeignKey(
        RecurringEventSeries,
        related_name="events",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )
    description = models.TextField(blank=True)
    starts_at = models.DateTimeField()
    venue = models.CharField(max_length=240)
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.DRAFT,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["starts_at"]

    def save(self, *args: object, **kwargs: object) -> None:
        if not self.slug:
            self.slug = slugify(self.title)
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.title


class TicketType(models.Model):
    event = models.ForeignKey(
        Event,
        related_name="ticket_types",
        on_delete=models.CASCADE,
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True)
    price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.00"))],
    )
    capacity = models.PositiveIntegerField(validators=[MinValueValidator(1)])
    sold = models.PositiveIntegerField(default=0)
    active = models.BooleanField(default=True)
    hidden = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["price", "name"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(sold__lte=models.F("capacity")),
                name="ticket_sold_not_over_capacity",
            ),
            models.CheckConstraint(
                condition=Q(capacity__gte=1),
                name="ticket_capacity_positive",
            ),
            models.CheckConstraint(
                condition=Q(price__gte=Decimal("0.00")),
                name="ticket_price_nonnegative",
            ),
        ]

    @property
    def remaining(self) -> int:
        reserved = getattr(self, "_reserved_quantity", None)
        if reserved is None:
            reserved = (
                self.order_items.filter(
                    order__status=Order.Status.PENDING,
                    order__expires_at__gt=timezone.now(),
                ).aggregate(quantity=Sum("quantity"))["quantity"]
                or 0
            )
        return max(0, self.capacity - self.sold - reserved)

    def __str__(self) -> str:
        return f"{self.event.title} — {self.name}"


class SeatMap(models.Model):
    event = models.OneToOneField(
        Event,
        related_name="seat_map",
        on_delete=models.CASCADE,
    )
    width = models.PositiveSmallIntegerField(default=1000)
    height = models.PositiveSmallIntegerField(default=640)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=Q(width__gte=100, width__lte=5000),
                name="seat_map_width_bounds",
            ),
            models.CheckConstraint(
                condition=Q(height__gte=100, height__lte=5000),
                name="seat_map_height_bounds",
            ),
        ]

    def __str__(self) -> str:
        return f"Seats — {self.event.title}"


class SeatZone(models.Model):
    seat_map = models.ForeignKey(
        SeatMap,
        related_name="zones",
        on_delete=models.CASCADE,
    )
    key = models.SlugField(max_length=32)
    name = models.CharField(max_length=80)
    color = models.CharField(max_length=7, default="#7167E8")
    ticket_type = models.ForeignKey(
        TicketType,
        related_name="seat_zones",
        on_delete=models.CASCADE,
    )

    class Meta:
        ordering = ["name", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["seat_map", "key"],
                name="unique_seat_zone_key",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} — {self.seat_map.event.title}"


class Seat(models.Model):
    seat_map = models.ForeignKey(
        SeatMap,
        related_name="seats",
        on_delete=models.CASCADE,
    )
    zone = models.ForeignKey(
        SeatZone,
        related_name="seats",
        on_delete=models.CASCADE,
    )
    label = models.CharField(max_length=32)
    row_label = models.CharField(max_length=12)
    seat_number = models.PositiveSmallIntegerField()
    x = models.PositiveSmallIntegerField()
    y = models.PositiveSmallIntegerField()
    blocked = models.BooleanField(default=False)

    class Meta:
        ordering = ["row_label", "seat_number", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["seat_map", "label"],
                name="unique_seat_map_label",
            ),
            models.CheckConstraint(
                condition=Q(seat_number__gte=1),
                name="seat_number_positive",
            ),
        ]
        indexes = [
            models.Index(fields=["seat_map", "zone", "row_label", "seat_number"]),
        ]

    def __str__(self) -> str:
        return self.label


class TicketPriceTier(models.Model):
    ticket_type = models.ForeignKey(
        TicketType,
        related_name="price_tiers",
        on_delete=models.CASCADE,
    )
    name = models.CharField(max_length=120)
    price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.00"))],
    )
    capacity = models.PositiveIntegerField(validators=[MinValueValidator(1)])
    sold = models.PositiveIntegerField(default=0)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["position", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(sold__lte=F("capacity")),
                name="price_tier_sold_not_over_capacity",
            ),
            models.CheckConstraint(
                condition=Q(capacity__gte=1),
                name="price_tier_capacity_positive",
            ),
            models.CheckConstraint(
                condition=Q(price__gte=Decimal("0.00")),
                name="price_tier_price_nonnegative",
            ),
            models.UniqueConstraint(
                fields=["ticket_type", "position"],
                name="unique_ticket_price_tier_position",
            ),
        ]

    @property
    def remaining(self) -> int:
        reserved = getattr(self, "_reserved_quantity", None)
        if reserved is None:
            reserved = (
                self.order_items.filter(
                    order__status=Order.Status.PENDING,
                    order__expires_at__gt=timezone.now(),
                ).aggregate(quantity=Sum("quantity"))["quantity"]
                or 0
            )
        return max(0, self.capacity - self.sold - reserved)

    def __str__(self) -> str:
        return f"{self.ticket_type.name} — {self.name}"


class PromotionCode(models.Model):
    class DiscountType(models.TextChoices):
        PERCENT = "percent", "Percentage"
        FIXED = "fixed", "Fixed amount"

    event = models.ForeignKey(
        Event,
        related_name="promotion_codes",
        on_delete=models.CASCADE,
    )
    ticket_type = models.ForeignKey(
        TicketType,
        related_name="promotion_codes",
        on_delete=models.CASCADE,
        blank=True,
        null=True,
    )
    code = models.CharField(max_length=64)
    discount_type = models.CharField(max_length=12, choices=DiscountType.choices)
    value = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.01"))],
    )
    max_uses = models.PositiveIntegerField(blank=True, null=True)
    used_count = models.PositiveIntegerField(default=0)
    starts_at = models.DateTimeField(blank=True, null=True)
    expires_at = models.DateTimeField(blank=True, null=True)
    active = models.BooleanField(default=True)
    reveals_hidden_tickets = models.BooleanField(default=False)

    class Meta:
        ordering = ["code"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "code"],
                name="unique_promotion_code_per_event",
            ),
            models.CheckConstraint(
                condition=Q(value__gt=Decimal("0.00")),
                name="promotion_value_positive",
            ),
            models.CheckConstraint(
                condition=Q(max_uses__isnull=True) | Q(max_uses__gt=0),
                name="promotion_max_uses_positive",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.code} — {self.event.title}"


class Order(models.Model):
    class Channel(models.TextChoices):
        ONLINE = "online", "Online"
        BOX_OFFICE = "box_office", "Box office"

    class PaymentMethod(models.TextChoices):
        STRIPE = "stripe", "Stripe"
        CASH = "cash", "Cash"
        CARD = "card", "Card"
        COMP = "comp", "Complimentary"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending payment"
        CONFIRMED = "confirmed", "Confirmed"
        CANCELLED = "cancelled", "Cancelled"
        EXPIRED = "expired", "Expired"
        REFUND_PENDING = "refund_pending", "Refund pending"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    event = models.ForeignKey(Event, related_name="orders", on_delete=models.PROTECT)
    channel = models.CharField(
        max_length=12,
        choices=Channel.choices,
        default=Channel.ONLINE,
        db_index=True,
    )
    payment_method = models.CharField(
        max_length=12,
        choices=PaymentMethod.choices,
        blank=True,
        default="",
    )
    cash_received = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        blank=True,
        null=True,
    )
    change_due = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=Decimal("0.00"),
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="created_orders",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )
    customer_name = models.CharField(max_length=180)
    customer_email = models.EmailField()
    idempotency_key = models.UUIDField()
    status = models.CharField(
        max_length=20,
        choices=Status.choices,
        default=Status.PENDING,
        db_index=True,
    )
    currency = models.CharField(max_length=3, default="USD")
    payment_session_id = models.CharField(
        max_length=255,
        blank=True,
        null=True,
        unique=True,
    )
    payment_expires_at = models.DateTimeField(blank=True, null=True)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2)
    discount_amount = models.DecimalField(
        max_digits=12,
        decimal_places=2,
        default=Decimal("0.00"),
    )
    fees = models.DecimalField(max_digits=12, decimal_places=2)
    total = models.DecimalField(max_digits=12, decimal_places=2)
    promotion = models.ForeignKey(
        PromotionCode,
        related_name="orders",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )
    expires_at = models.DateTimeField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"],
                name="unique_event_idempotency_key",
            ),
            models.CheckConstraint(
                condition=Q(subtotal__gte=Decimal("0.00")),
                name="order_subtotal_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(fees__gte=Decimal("0.00")),
                name="order_fees_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(discount_amount__gte=Decimal("0.00")),
                name="order_discount_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(discount_amount__lte=F("subtotal")),
                name="order_discount_not_over_subtotal",
            ),
            models.CheckConstraint(
                condition=Q(cash_received__isnull=True)
                | Q(cash_received__gte=Decimal("0.00")),
                name="order_cash_received_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(change_due__gte=Decimal("0.00")),
                name="order_change_due_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(total=F("subtotal") - F("discount_amount") + F("fees")),
                name="order_total_matches_amounts",
            ),
        ]

    @property
    def effective_status(self) -> str:
        if self.status == self.Status.PENDING and self.expires_at <= timezone.now():
            return self.Status.EXPIRED
        return self.status

    def __str__(self) -> str:
        return f"{self.event.title} — {self.customer_email}"


class OrderItem(models.Model):
    order = models.ForeignKey(Order, related_name="items", on_delete=models.CASCADE)
    ticket_type = models.ForeignKey(
        TicketType,
        related_name="order_items",
        on_delete=models.PROTECT,
    )
    price_tier = models.ForeignKey(
        TicketPriceTier,
        related_name="order_items",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )
    quantity = models.PositiveSmallIntegerField()
    unit_price = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(Decimal("0.00"))],
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["order", "ticket_type"],
                name="unique_order_ticket_type",
            ),
            models.CheckConstraint(
                condition=Q(quantity__gt=0),
                name="order_item_quantity_positive",
            ),
            models.CheckConstraint(
                condition=Q(unit_price__gte=Decimal("0.00")),
                name="order_item_price_nonnegative",
            ),
        ]

    @property
    def line_total(self) -> Decimal:
        return self.unit_price * self.quantity

    def __str__(self) -> str:
        return f"{self.quantity} × {self.ticket_type.name}"


class SeatReservation(models.Model):
    class Status(models.TextChoices):
        HELD = "held", "Held"
        CONFIRMED = "confirmed", "Confirmed"
        RELEASED = "released", "Released"

    seat = models.ForeignKey(
        Seat,
        related_name="reservations",
        on_delete=models.PROTECT,
    )
    order_item = models.ForeignKey(
        OrderItem,
        related_name="seat_reservations",
        on_delete=models.CASCADE,
    )
    issued_ticket = models.OneToOneField(
        "IssuedTicket",
        related_name="seat_reservation",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )
    status = models.CharField(
        max_length=12,
        choices=Status.choices,
        default=Status.HELD,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["seat__row_label", "seat__seat_number"]
        constraints = [
            models.UniqueConstraint(
                fields=["seat"],
                condition=Q(status__in=["held", "confirmed"]),
                name="unique_active_seat_reservation",
            ),
        ]


class WaitlistEntry(models.Model):
    class Status(models.TextChoices):
        WAITING = "waiting", "Waiting"
        OFFERED = "offered", "Offer sent"
        CONVERTED = "converted", "Purchased"
        EXPIRED = "expired", "Offer expired"

    event = models.ForeignKey(
        Event,
        related_name="waitlist_entries",
        on_delete=models.CASCADE,
    )
    ticket_type = models.ForeignKey(
        TicketType,
        related_name="waitlist_entries",
        on_delete=models.CASCADE,
    )
    customer_name = models.CharField(max_length=180)
    customer_email = models.EmailField()
    quantity = models.PositiveSmallIntegerField()
    token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    status = models.CharField(
        max_length=12,
        choices=Status.choices,
        default=Status.WAITING,
        db_index=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    offered_at = models.DateTimeField(blank=True, null=True)
    offer_expires_at = models.DateTimeField(blank=True, null=True, db_index=True)
    order = models.ForeignKey(
        Order,
        related_name="waitlist_entries",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(quantity__gt=0),
                name="waitlist_quantity_positive",
            ),
            models.UniqueConstraint(
                fields=["event", "ticket_type", "customer_email"],
                condition=Q(status__in=["waiting", "offered"]),
                name="unique_active_waitlist_contact",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.customer_email} — {self.ticket_type.name} ({self.status})"


class IssuedTicket(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    order = models.ForeignKey(
        Order,
        related_name="issued_tickets",
        on_delete=models.PROTECT,
    )
    ticket_type = models.ForeignKey(
        TicketType,
        related_name="issued_tickets",
        on_delete=models.PROTECT,
    )
    issued_at = models.DateTimeField(auto_now_add=True)
    checked_in_at = models.DateTimeField(blank=True, null=True, db_index=True)
    checked_in_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        related_name="checked_in_tickets",
        on_delete=models.SET_NULL,
        blank=True,
        null=True,
    )

    class Meta:
        ordering = ["issued_at", "id"]

    def __str__(self) -> str:
        return f"{self.ticket_type.name} — {self.id}"
