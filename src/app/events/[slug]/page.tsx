import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarDays, MapPin, Ticket } from "lucide-react";

import { getPublicEvent } from "@/lib/public-event";
import { ShareButton } from "./share-button";
import { WaitlistSignup } from "./waitlist-signup";

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const event = await getPublicEvent(slug);
  if (!event) return { title: "Event not found" };
  const siteUrl = (
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
  ).replace(/\/+$/, "");
  return {
    title: `${event.title} — Tickets`,
    description: event.description,
    alternates: {
      canonical: `${siteUrl}/events/${event.slug}`,
    },
    openGraph: {
      title: event.title,
      description: event.description,
      type: "website",
    },
  };
}

export default async function PublicEventPage({ params }: Props) {
  const { slug } = await params;
  const event = await getPublicEvent(slug);
  if (!event) notFound();
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  });

  return (
    <main className="public-event">
      <nav className="public-nav" aria-label="Event navigation">
        <Link className="public-brand" href="/">
          <span className="public-brand-mark" />
          <span>eventflow</span>
        </Link>
        <ShareButton title={event.title} />
      </nav>

      <article className={`public-hero public-hero--${event.accent}`}>
        <div className="public-hero-glow" />
        <Link className="public-back" href="/">
          <ArrowLeft size={16} />
          <span>All events</span>
        </Link>
        <div className="public-hero-copy">
          <span className="public-category">{event.category}</span>
          <h1>{event.title}</h1>
          <p>{event.description}</p>
          <div className="public-meta">
            <span>
              <CalendarDays size={17} />
              <span>
                <strong>{event.date}</strong>
                <small>{event.time}</small>
              </span>
            </span>
            <span>
              <MapPin size={17} />
              <span>
                <strong>{event.venue}</strong>
                {event.address && <small>{event.address}</small>}
              </span>
            </span>
          </div>
        </div>
      </article>

      <section className="public-content" aria-label="Event details and tickets">
        <div className="public-details">
          <span className="public-section-kicker">About the event</span>
          <h2>Everything to know.</h2>
          <p>{event.description}</p>
          {event.seriesDates.length > 1 && (
            <section className="series-dates" aria-label="Other event dates">
              <span className="public-section-kicker">More dates</span>
              <div>
                {event.seriesDates.map((date) => (
                  <Link
                    aria-current={date.slug === event.slug ? "date" : undefined}
                    className={
                      date.slug === event.slug
                        ? "series-date series-date--current"
                        : "series-date"
                    }
                    href={`/events/${date.slug}`}
                    key={date.slug}
                  >
                    <strong>{date.date}</strong>
                    <span>{date.time}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="ticket-panel" aria-label="Available tickets">
          <div className="ticket-panel-heading">
            <div>
              <span>Tickets</span>
              <h2>Choose your experience</h2>
            </div>
            <Ticket size={20} />
          </div>
          {event.tickets.map((ticket) => {
            const availableTiers = ticket.priceTiers.filter(
              (tier) => tier.remaining > 0,
            );
            const available = ticket.remaining > 0 || availableTiers.length > 0;
            const startingPrice = availableTiers.length
              ? Math.min(...availableTiers.map((tier) => tier.price))
              : ticket.price;
            const checkoutHref = `/events/${event.slug}/checkout?ticket=${ticket.id}`;

            return (
              <div className="ticket-option-wrap" key={ticket.id}>
                {available ? (
                  <Link className="ticket-option" href={checkoutHref}>
                    <div>
                      <strong>{ticket.name}</strong>
                      <span>{ticket.description}</span>
                      <small>{ticket.remaining} remaining</small>
                    </div>
                    <div>
                      <strong>{money.format(startingPrice)}</strong>
                      <span aria-hidden="true">→</span>
                    </div>
                  </Link>
                ) : (
                  <>
                    <div className="ticket-option ticket-option--sold-out">
                      <div>
                        <strong>{ticket.name}</strong>
                        <span>{ticket.description}</span>
                        <small>Sold out</small>
                      </div>
                      <div>
                        <strong>{money.format(ticket.price)}</strong>
                      </div>
                    </div>
                    <WaitlistSignup
                      slug={event.slug}
                      ticketId={ticket.id}
                      ticketName={ticket.name}
                    />
                  </>
                )}
              </div>
            );
          })}
          {event.hasHiddenTickets && (
            <p className="ticket-hidden-note">
              Have an access code? Enter it at checkout to unlock hidden tickets.
            </p>
          )}
          {event.hasSeating && (
            <p className="ticket-hidden-note">
              Reserved seats can be selected securely during checkout.
            </p>
          )}
          <p className="ticket-fee-note">All prices include applicable fees.</p>
        </aside>
      </section>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Event",
            name: event.title,
            description: event.description,
            startDate: event.startsAt,
            location: {
              "@type": "Place",
              name: event.venue,
              ...(event.address ? { address: event.address } : {}),
            },
          }).replace(/</g, "\\u003c"),
        }}
      />
    </main>
  );
}
