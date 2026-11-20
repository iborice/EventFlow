import Link from "next/link";

export default function EventNotFound() {
  return (
    <main className="public-event">
      <nav className="public-nav" aria-label="Event navigation">
        <Link className="public-brand" href="/">
          <span className="public-brand-mark" />
          <span>eventflow</span>
        </Link>
      </nav>
      <section className="checkout-confirmation event-not-found">
        <span className="checkout-kicker">Event unavailable</span>
        <h1>This event isn’t available.</h1>
        <p>
          The link may be incorrect, or the event may still be a draft. Public
          event pages are available after an event is published.
        </p>
        <Link className="checkout-primary unavailable-link" href="/">
          Return to EventFlow
        </Link>
      </section>
    </main>
  );
}
