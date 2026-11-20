import { getPublicEvent } from "@/lib/public-event";
import { CheckoutForm } from "./checkout-form";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    ticket?: string | string[];
    payment?: string | string[];
  }>;
};

export default async function CheckoutPage({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const ticket = Array.isArray(query.ticket) ? query.ticket[0] : query.ticket;
  const payment = Array.isArray(query.payment) ? query.payment[0] : query.payment;

  return (
    <CheckoutForm
      event={await getPublicEvent(slug) ?? null}
      initialTicket={ticket ?? null}
      key={slug}
      paymentCancelled={payment === "cancelled"}
    />
  );
}
