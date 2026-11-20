import { OrderConfirmation } from "./order-confirmation";

type Props = {
  searchParams: Promise<{ order?: string | string[] }>;
};

export default async function OrderSuccessPage({ searchParams }: Props) {
  const query = await searchParams;
  const orderId = Array.isArray(query.order) ? query.order[0] : query.order;

  return <OrderConfirmation orderId={orderId ?? null} />;
}
