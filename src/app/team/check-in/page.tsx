import { CheckInOperations } from "../check-in";

type Props = {
  searchParams: Promise<{
    organization?: string | string[];
    event_id?: string | string[];
  }>;
};

export default async function CheckInPage({ searchParams }: Props) {
  const query = await searchParams;
  const organization = Array.isArray(query.organization)
    ? query.organization[0]
    : query.organization;
  const eventId = Array.isArray(query.event_id)
    ? query.event_id[0]
    : query.event_id;

  return (
    <CheckInOperations
      initialEventId={eventId}
      initialOrganization={organization}
    />
  );
}
