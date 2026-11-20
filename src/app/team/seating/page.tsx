import { SeatDesignerOperations } from "../seat-designer";

type Props = {
  searchParams: Promise<{
    organization?: string | string[];
    event_id?: string | string[];
  }>;
};

export default async function SeatingPage({ searchParams }: Props) {
  const query = await searchParams;
  const organization = Array.isArray(query.organization)
    ? query.organization[0]
    : query.organization;
  const eventId = Array.isArray(query.event_id)
    ? query.event_id[0]
    : query.event_id;

  return (
    <SeatDesignerOperations
      initialEventId={eventId}
      initialOrganization={organization}
    />
  );
}
