from io import BytesIO

import qrcode
from django.http import HttpResponse
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from .models import IssuedTicket, SeatReservation


def ticket_pdf(ticket: IssuedTicket) -> HttpResponse:
    output = BytesIO()
    document = canvas.Canvas(output, pagesize=letter)
    _, page_height = letter
    event = ticket.order.event

    document.setTitle(f"{event.title} — Ticket")
    document.setFont("Helvetica-Bold", 20)
    document.drawString(48, page_height - 64, event.title[:55])
    document.setFont("Helvetica", 12)
    document.drawString(48, page_height - 100, f"Ticket: {ticket.ticket_type.name[:70]}")
    document.drawString(48, page_height - 124, f"Attendee: {ticket.order.customer_name[:70]}")
    document.drawString(48, page_height - 148, f"Email: {ticket.order.customer_email[:70]}")
    document.drawString(48, page_height - 172, f"Venue: {event.venue[:70]}")
    document.drawString(
        48,
        page_height - 196,
        f"Starts: {event.starts_at.strftime('%Y-%m-%d %H:%M UTC')}",
    )
    assignment = (
        SeatReservation.objects.select_related("seat")
        .filter(
            issued_ticket=ticket,
            status=SeatReservation.Status.CONFIRMED,
        )
        .first()
    )
    if assignment:
        document.drawString(
            48,
            page_height - 220,
            f"Seat: {assignment.seat.label}",
        )
    document.setFont("Helvetica-Bold", 10)
    document.drawString(
        48,
        page_height - (248 if assignment else 224),
        f"Ticket ID: {ticket.id}",
    )

    qr_image = qrcode.make(str(ticket.id))
    qr_output = BytesIO()
    qr_image.save(qr_output, format="PNG")
    qr_output.seek(0)
    document.drawImage(
        ImageReader(qr_output),
        48,
        page_height - 390,
        width=140,
        height=140,
        preserveAspectRatio=True,
    )
    document.setFont("Helvetica", 10)
    document.drawString(48, page_height - 414, "Present this QR code at entry.")
    document.save()

    response = HttpResponse(output.getvalue(), content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="eventflow-ticket-{ticket.id}.pdf"'
    response["Cache-Control"] = "private, no-store"
    return response
