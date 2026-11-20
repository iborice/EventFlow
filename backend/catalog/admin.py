from django import forms
from django.contrib import admin

from .models import (
    Event,
    PromotionCode,
    RecurringEventSeries,
    TicketPriceTier,
    TicketType,
    WaitlistEntry,
)


class TicketTypeInlineForm(forms.ModelForm):
    price = forms.DecimalField(min_value=0, decimal_places=2, max_digits=10)
    capacity = forms.IntegerField(min_value=1)

    class Meta:
        model = TicketType
        fields = ("name", "description", "price", "capacity", "active", "hidden")


class TicketTypeAdminForm(forms.ModelForm):
    price = forms.DecimalField(min_value=0, decimal_places=2, max_digits=10)
    capacity = forms.IntegerField(min_value=1)

    class Meta:
        model = TicketType
        fields = "__all__"


class TicketTypeInline(admin.TabularInline):
    model = TicketType
    form = TicketTypeInlineForm
    extra = 1
    fields = ("name", "description", "price", "capacity", "active", "hidden")


class PromotionCodeInline(admin.TabularInline):
    model = PromotionCode
    extra = 0
    fields = (
        "code",
        "ticket_type",
        "discount_type",
        "value",
        "max_uses",
        "starts_at",
        "expires_at",
        "active",
        "reveals_hidden_tickets",
    )


class TicketPriceTierInline(admin.TabularInline):
    model = TicketPriceTier
    extra = 0
    fields = ("name", "price", "capacity", "position")


@admin.register(Event)
class EventAdmin(admin.ModelAdmin):
    list_display = ("title", "organization", "series", "starts_at", "venue", "status")
    list_filter = ("organization", "status", "starts_at")
    search_fields = ("title", "venue")
    prepopulated_fields = {"slug": ("title",)}
    inlines = [TicketTypeInline, PromotionCodeInline]


@admin.register(TicketType)
class TicketTypeAdmin(admin.ModelAdmin):
    form = TicketTypeAdminForm
    list_display = ("name", "event", "price", "capacity", "sold", "active")
    list_filter = ("active",)
    search_fields = ("name", "event__title")
    readonly_fields = ("sold",)
    inlines = [TicketPriceTierInline]


@admin.register(RecurringEventSeries)
class RecurringEventSeriesAdmin(admin.ModelAdmin):
    list_display = ("title", "organization", "created_at")
    list_filter = ("organization",)
    search_fields = ("title", "organization__name")


@admin.register(WaitlistEntry)
class WaitlistEntryAdmin(admin.ModelAdmin):
    list_display = (
        "customer_email",
        "event",
        "ticket_type",
        "quantity",
        "status",
        "created_at",
        "offer_expires_at",
    )
    list_filter = ("status", "event")
    search_fields = ("customer_email", "customer_name", "event__title")
    readonly_fields = (
        "token",
        "created_at",
        "offered_at",
        "offer_expires_at",
        "order",
    )
