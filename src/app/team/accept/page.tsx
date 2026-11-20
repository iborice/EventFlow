import InvitationAcceptance from "@/app/team/invitation-acceptance";

export default async function AcceptInvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;
  return <InvitationAcceptance token={typeof token === "string" ? token : ""} />;
}
