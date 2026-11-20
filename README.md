# EventFlow

EventFlow is an original, MIT-licensed event and ticketing platform in active
development. It combines a Next.js organizer UI and public event pages with a
Django Ninja REST API. Paid checkout uses Stripe Checkout; tickets are issued
after a verified payment webhook. Organizer accounts, organization workspaces,
team permissions, and core ticketing flows are included.

## Current delivery

| Area | State |
| --- | --- |
| Next.js 16 / TypeScript strict frontend | Implemented |
| Responsive organizer dashboard and light/dark theme | Implemented |
| Event search, status filter, organization dashboard metrics | Implemented; metrics are loaded from the API |
| Event and first ticket creation | Implemented in a three-step dashboard form with draft/publish and sequential price tiers |
| Public event page and ticket availability | Implemented; published events loaded from the API |
| Stripe Checkout and payment webhook | Implemented for card payments; test keys and a reachable webhook are required |
| Issued ticket QR codes and downloadable PDFs | Implemented after payment confirmation; generated on demand |
| Event and ticket models plus public `GET /api/v1/events` and `GET /api/v1/events/{slug}` | Implemented; published events only |
| Temporary reservations, inventory holds, and idempotent checkout | Implemented |
| Accounts, CSRF-protected session login and registration | Implemented; OAuth, password reset, and 2FA are not included |
| Organizations, memberships, invitations, and event-level access | Implemented; invite links are shared manually, without email delivery |
| Team roles (Admin, Organizer, View only) and dashboard scoping | Implemented |
| Recurring event series | Implemented for up to 1,200 custom-dated occurrences, each with its own capacity and prices |
| Sequential ticket price tiers | Implemented with per-tier inventory holds and sold counts |
| Promotion codes and hidden tickets | Implemented with percentage/fixed discounts, schedules, usage limits, optional ticket targeting, and hidden-ticket unlocking |
| Waitlists | Implemented as FIFO ticket offers after inventory expires, with token status/claim APIs and scheduled Celery processing |
| Reserved seats | Implemented with 3,000-seat maps, zones, availability holds, checkout seat selection, and seat labels on issued PDFs |
| Box office | Implemented for cash, complimentary, and external-terminal card sales, with change calculation and PDF ticket links |
| Check-in | Implemented with ticket search, QR camera support where the browser provides `BarcodeDetector`, USB scanner input, and offline UUID queue sync |
| Django 5.2 / Django Ninja REST API and OpenAPI docs | Health, catalog, orders, Stripe checkout, webhooks, and ticket downloads |
| PostgreSQL / Redis / Celery / Nginx Compose foundation | Configuration included |
| CI, frontend unit tests, backend API tests | Included |
| Stripe Connect, reports, widgets, email notifications | Planned; not implemented |

The dashboard reads event, sales, and team metrics from the selected
organization. Its three-step event form creates a draft or published event and
its first ticket type; recurring series, promotions, and later event edits are
available through the authenticated organizer API but do not yet have dedicated
dashboard forms. Team invitations are created as seven-day links to copy and
share; the invitee must sign in with the invited email address to accept.

Next.js 16 is used instead of the suggested Next.js 15 because the available
Next.js 15 release resolved to vulnerable dependencies during setup.

## Run locally

### Frontend

Requirements: Node.js 22 and npm.

```powershell
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### API

Requirements: Python 3.12.

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```

- Sign in or register at [http://localhost:3000](http://localhost:3000), create/select a workspace, then use **Create event** on the organizer dashboard.
- Health: [http://127.0.0.1:8000/api/v1/health](http://127.0.0.1:8000/api/v1/health)
- Interactive API docs: [http://127.0.0.1:8000/api/v1/docs](http://127.0.0.1:8000/api/v1/docs)
- OpenAPI JSON: [http://127.0.0.1:8000/api/v1/openapi.json](http://127.0.0.1:8000/api/v1/openapi.json)
- Published event catalog: `GET /api/v1/events`
- Published event detail: `GET /api/v1/events/{slug}`
- Register and create a workspace: `POST /api/v1/auth/register`
- Sign in/out and session: `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/session`
- List workspaces: `GET /api/v1/organizations`
- Organization dashboard: `GET /api/v1/organizations/{slug}/dashboard`
- Team roles and invitations: `/api/v1/organizations/{slug}/members` and `/invitations`
- Accept a team invitation: `POST /api/v1/invitations/{token}/accept`
- Create events and recurring series: `POST /api/v1/organizations/{slug}/events` and `/recurring-events`
- Read/save an event seat map: `/api/v1/organizations/{slug}/events/{event_id}/seating`
- Record a box-office sale: `POST /api/v1/organizations/{slug}/events/{event_id}/box-office/orders`
- Search attendees and synchronize check-ins: `/api/v1/organizations/{slug}/events/{event_id}/check-in/search` and `/check-in/sync`
- Create/list promotions: `/api/v1/organizations/{slug}/events/{event_id}/promotions`
- Validate promotion codes: `POST /api/v1/events/{slug}/promotions/validate`
- Temporary reservation: `POST /api/v1/events/{slug}/reservations`
- Join/check/claim a waitlist offer: `POST /api/v1/events/{slug}/waitlist`, `GET /api/v1/waitlist/{token}`, and `POST /api/v1/waitlist/{token}/checkout-session`
- Stripe Checkout session: `POST /api/v1/orders/{order_id}/checkout-session`
- Stripe webhook: `POST /api/v1/payments/stripe/webhook`
- Order status: `GET /api/v1/orders/{order_id}`
- Ticket PDF: `GET /api/v1/tickets/{ticket_id}/pdf`

The API uses SQLite for local development unless `POSTGRES_HOST` is set.
Reservations accept `ticket_type_id`, `quantity` (1-6), `customer_name`,
`customer_email`, and a UUID `idempotency_key`. A successful reservation holds
inventory for 10 minutes and returns an order ID and price snapshot. Repeating
the same request with the same key returns the existing reservation; reusing
that key with different order details returns `409`. Insufficient inventory
returns `409`, while rate limiting returns `429` after 20 requests per minute
per client IP. The API calculates all amounts from the stored ticket price and
currently adds no service fee.
Price tiers are sold in order, and each tier's capacity is held independently.
Recurring series accept at most 1,200 distinct occurrence times per request.
Promotion usage is counted when an order is confirmed; pending reservations
temporarily reserve limited-use codes. Waitlist offers last 15 minutes by
default. Celery Beat checks expired reservations every minute and creates
offers, but automatic email delivery is not configured; guests can check their
offer status with the waitlist token.

For local card payments, set Stripe **test-mode** credentials in the backend
process before starting Django:

```powershell
$env:STRIPE_SECRET_KEY = "sk_test_..."
$env:STRIPE_WEBHOOK_SECRET = "whsec_..."
$env:PUBLIC_SITE_URL = "http://localhost:3000"
```

In another terminal, forward Stripe test events to the local webhook:

```powershell
stripe listen --forward-to localhost:8000/api/v1/payments/stripe/webhook
```

Copy the `whsec_...` value printed by Stripe CLI into
`STRIPE_WEBHOOK_SECRET`. For Docker Compose, put both test keys in `.env`; use
`stripe listen --forward-to localhost/api/v1/payments/stripe/webhook`. The
webhook is the authority for confirming payment and issuing tickets; returning
from Stripe alone never marks an order paid. Free tickets are confirmed without
Stripe. Paid tickets download as PDFs containing a unique QR code. This MVP
uses the platform Stripe account; Connect transfers, refunds UI, email delivery,
and production payment operations remain future work.

### Seat maps, box office, and check-in

Open an event from the dashboard and use **Open event operations** to access its
seat designer, box office, and check-in views. Seat maps support up to 3,000
seats and 20 zones. Each reserved-seat ticket's configured capacity must equal
the number of seats assigned to its zones. Configure a map before selling
reserved-seat tickets: the API rejects edits after tickets have sold or while
seat holds/assignments are active.

The box office supports cash with change calculation, complimentary tickets,
and recording a card-terminal sale. Card payments are **not processed by
EventFlow**: staff must charge the customer on a separate terminal, and the UI
does not collect or store card details. The API validates inventory and seat
availability and issues tickets immediately after the sale.

Check-in accepts ticket UUIDs from a QR scan, a USB scanner acting as keyboard
input, or attendee search. Camera decoding requires a secure browser context
with `getUserMedia` and the native `BarcodeDetector` API; the USB/manual input
remains available otherwise. Offline scans are stored as ticket UUIDs only in
that browser's local storage and synchronized idempotently when connectivity
returns. Keep the device and browser storage available until the queue reports
that it has synchronized; there is no cross-device offline queue.

## Run the full stack with Docker Compose

Copy `.env.example` to `.env`, replace the secret and database password with
unique random values, then run:

```powershell
docker compose up --build
```

The Nginx entry point is [http://localhost](http://localhost); the API is routed
under `/api/v1/`, and Django admin under `/admin/`. PostgreSQL data is kept in
the named `postgres_data` volume. Compose runs migrations once before starting
the API and worker containers. Create an admin user with:

```powershell
docker compose exec api python manage.py createsuperuser
```

The provided Django development server and default configuration are for local
development, **not production deployment**. Production requires hardened
settings, TLS, a production WSGI/ASGI server, real secrets, backups, and
deployment-specific operational review.

## Quality checks

From the project root:

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

Backend:

```powershell
cd backend
pytest
```

The CI workflow runs these checks on pushes to `main` and pull requests.

### Dependency audit

`npm audit --omit=dev` currently reports no production dependency advisories.
The full development dependency tree reports a high-severity ReDoS advisory in
`picomatch` ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)),
reachable through the lint/test toolchain. The advisory currently lists no
patched release, so a safe upstream fix is pending; do not apply the suggested
forced downgrade. Re-run `npm audit` before deployment and remove or upgrade
affected tooling when a patched release is available.

## Architecture

- `src/app/`: Next.js App Router UI and global theme.
- `src/lib/`: shared frontend API client and validated domain types.
- `backend/config/`: Django settings, Django Ninja REST API and Celery app.
- `infra/`: Nginx reverse-proxy configuration.
- `docker-compose.yml`: web, API, worker, PostgreSQL, Redis and Nginx services.

API contracts are defined with Django Ninja and exposed as OpenAPI. Waitlist
expiration and inventory-release work runs through Celery and Celery Beat.
Remaining integrations, including transactional email, are planned with their
respective features.

## Next milestones

1. Add dashboard forms for recurring series and promotion management; add
   add-ons, shared inventory, and waitlist email notifications.
2. Reports, exports, widgets, email delivery, accessibility/performance audits,
   and purchase-flow E2E coverage.

## License

MIT. The implementation in this repository is original and does not include
Hi.Events source code.

See [design-system.md](./design-system.md) for visual tokens, component rules,
and accessibility guidance.
