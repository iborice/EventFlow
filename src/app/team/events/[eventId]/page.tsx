import { notFound } from "next/navigation";
import { EventSettings } from "@/app/team/event-settings";

type Props = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<{ organization?: string | string[] }>;
};

export default async function EventSettingsPage({
  params,
  searchParams,
}: Props) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const parsedEventId = Number(eventId);
  if (!Number.isSafeInteger(parsedEventId) || parsedEventId < 1) notFound();

  const organization = Array.isArray(query.organization)
    ? query.organization[0]
    : query.organization;

  return (
    <EventSettings
      eventId={parsedEventId}
      initialOrganization={organization}
    />
  );
}
