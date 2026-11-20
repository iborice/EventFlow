"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import {
  ApiError,
  apiRequest,
  getCurrentUser,
  getOrganizationDashboard,
  getOrganizationInvitations,
  getOrganizationMembers,
  getOrganizations,
  type Organization,
  type OrganizationDashboard,
  type OrganizationInvitation,
  type OrganizationMember,
  type User,
} from "@/lib/organizations";

const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  role: z.enum(["organizer", "viewer"]),
});

export default function TeamWorkspace() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [slug, setSlug] = useState("");
  const [dashboard, setDashboard] = useState<OrganizationDashboard | null>(null);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [invitations, setInvitations] = useState<OrganizationInvitation[]>([]);
  const [createdInvitation, setCreatedInvitation] =
    useState<OrganizationInvitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    async function loadOrganizations() {
      try {
        const [currentUser, workspaces] = await Promise.all([
          getCurrentUser(),
          getOrganizations(),
        ]);
        if (!active) return;
        setUser(currentUser);
        setOrganizations(workspaces);
        setSlug(workspaces[0]?.slug ?? "");
        if (!workspaces.length) setLoading(false);
      } catch (requestError) {
        if (!active) return;
        if (requestError instanceof ApiError && requestError.status === 401) {
          router.push(`/login?next=${encodeURIComponent("/team")}`);
          return;
        }
        setError(messageFor(requestError));
        setLoading(false);
      }
    }
    void loadOrganizations();
    return () => {
      active = false;
    };
  }, [router]);

  useEffect(() => {
    if (!slug) return;
    let active = true;
    async function loadTeam() {
      try {
        const [summary, teamMembers] = await Promise.all([
          getOrganizationDashboard(slug),
          getOrganizationMembers(slug),
        ]);
        const pendingInvitations =
          summary.organization.role === "admin"
            ? await getOrganizationInvitations(slug)
            : [];
        if (!active) return;
        setDashboard(summary);
        setMembers(teamMembers);
        setInvitations(pendingInvitations);
      } catch (requestError) {
        if (!active) return;
        setError(messageFor(requestError));
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadTeam();
    return () => {
      active = false;
    };
  }, [slug]);

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const formData = new FormData(event.currentTarget);
    const parsed = inviteSchema.safeParse({
      email: formData.get("email"),
      role: formData.get("role"),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the invitation details.");
      return;
    }
    setSaving(true);
    try {
      const invitation = await apiRequest<OrganizationInvitation>(
        `/organizations/${encodeURIComponent(slug)}/invitations`,
        { method: "POST", body: JSON.stringify(parsed.data) },
      );
      setCreatedInvitation(invitation);
      setInvitations((current) => [invitation, ...current]);
      setNotice(`Invitation link created for ${invitation.email}.`);
      form.reset();
    } catch (requestError) {
      setError(messageFor(requestError));
    } finally {
      setSaving(false);
    }
  }

  async function copyInvitationLink(invitation: OrganizationInvitation) {
    if (!invitation.invite_url) return;
    try {
      await navigator.clipboard.writeText(invitation.invite_url);
      setNotice(`Invitation link copied for ${invitation.email}.`);
    } catch {
      setError("Clipboard access was denied. Select and copy the invitation link instead.");
    }
  }

  async function changeMemberRole(
    member: OrganizationMember,
    role: OrganizationMember["role"],
  ) {
    setError("");
    try {
      const updated = await apiRequest<OrganizationMember>(
        `/organizations/${encodeURIComponent(slug)}/members/${member.id}`,
        { method: "PUT", body: JSON.stringify({ role }) },
      );
      setMembers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice(`${member.name}'s role was updated.`);
    } catch (requestError) {
      setError(messageFor(requestError));
    }
  }

  async function removeMember(member: OrganizationMember) {
    setError("");
    try {
      await apiRequest<void>(
        `/organizations/${encodeURIComponent(slug)}/members/${member.id}`,
        { method: "DELETE" },
      );
      setMembers((current) => current.filter((item) => item.id !== member.id));
      setNotice(`${member.name} was removed from the workspace.`);
    } catch (requestError) {
      setError(messageFor(requestError));
    }
  }

  async function changeEventAccess(
    member: OrganizationMember,
    eventId: number,
    role: string,
  ) {
    setError("");
    try {
      if (role === "default") {
        await apiRequest<void>(
          `/organizations/${encodeURIComponent(slug)}/events/${eventId}/access/${member.id}`,
          { method: "DELETE" },
        );
        setMembers((current) =>
          current.map((item) =>
            item.id === member.id
              ? {
                  ...item,
                  event_access: item.event_access.filter(
                    (access) => access.event_id !== eventId,
                  ),
                }
              : item,
          ),
        );
      } else {
        const updated = await apiRequest<OrganizationMember>(
          `/organizations/${encodeURIComponent(slug)}/events/${eventId}/access/${member.id}`,
          { method: "PUT", body: JSON.stringify({ role }) },
        );
        setMembers((current) =>
          current.map((item) => (item.id === member.id ? updated : item)),
        );
      }
      setNotice(`Event access updated for ${member.name}.`);
    } catch (requestError) {
      setError(messageFor(requestError));
    }
  }

  const isAdmin = dashboard?.organization.role === "admin";

  return (
    <main className="management-screen">
      <header className="management-topbar">
        <Link aria-label="EventFlow home" className="brand" href="/">
          <span className="brand-mark"><span /></span>
          <span>eventflow</span>
        </Link>
        <div className="management-account">
          {organizations.length > 1 && (
            <label>
              <span className="sr-only">Workspace</span>
              <select
                value={slug}
                onChange={(event) => {
                  setLoading(true);
                  setError("");
                  setSlug(event.target.value);
                }}
              >
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.slug}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span>{user?.name}</span>
          <Link className="button button-quiet" href="/">Dashboard</Link>
        </div>
      </header>

      <div className="management-content">
        <div className="management-heading">
          <div>
            <p className="auth-eyebrow">WORKSPACE SETTINGS</p>
            <h1>People & permissions</h1>
            <p>Invite your team and decide what they can manage.</p>
          </div>
          {dashboard && (
            <span className="role-pill">{dashboard.organization.role}</span>
          )}
        </div>

        {error && <p className="management-error" role="alert">{error}</p>}
        {notice && <p className="management-notice" role="status">{notice}</p>}

        {loading ? (
          <div aria-label="Loading team settings" className="management-loading">
            <span /><span /><span />
          </div>
        ) : !dashboard ? (
          <section className="management-panel">
            <h2>No workspace available</h2>
            <p>Create a workspace or accept an invitation to get started.</p>
            <Link className="button button-primary" href="/">Create a workspace</Link>
          </section>
        ) : (
          <>
            {isAdmin && (
              <section aria-labelledby="invite-title" className="management-panel invite-panel">
                <div>
                  <h2 id="invite-title">Invite a teammate</h2>
                  <p>Invitations are shared as links and expire after seven days.</p>
                </div>
                <form className="invite-form" onSubmit={inviteMember}>
                  <label>
                    <span className="sr-only">Teammate email address</span>
                    <input autoComplete="email" name="email" placeholder="name@company.com" required type="email" />
                  </label>
                  <label>
                    <span className="sr-only">Role</span>
                    <select defaultValue="organizer" name="role">
                      <option value="organizer">Organizer</option>
                      <option value="viewer">View only</option>
                    </select>
                  </label>
                  <button className="button button-primary" disabled={saving} type="submit">
                    {saving ? "Creating link..." : "Create invite link"}
                  </button>
                </form>
                {createdInvitation?.invite_url && (
                  <div className="invite-result">
                    <span>Share this link with {createdInvitation.email}</span>
                    <a href={createdInvitation.invite_url}>{createdInvitation.invite_url}</a>
                    <button className="text-button" onClick={() => void copyInvitationLink(createdInvitation)} type="button">
                      Copy invitation link
                    </button>
                  </div>
                )}
              </section>
            )}

            <section aria-labelledby="members-title" className="management-panel">
              <div className="management-section-heading">
                <div>
                  <h2 id="members-title">Team members</h2>
                  <p>{members.length} people in {dashboard.organization.name}</p>
                </div>
              </div>
              {members.length ? (
                <div className="team-list">
                  {members.map((member) => (
                    <article className="team-member" key={member.id}>
                      <div className="team-member-identity">
                        <span className="team-avatar">{initials(member.name)}</span>
                        <span><strong>{member.name}</strong><small>{member.email}</small></span>
                      </div>
                      <div className="team-member-controls">
                        {isAdmin && member.role !== "admin" ? (
                          <>
                            <label>
                              <span className="sr-only">Role for {member.name}</span>
                              <select
                                aria-label={`Role for ${member.name}`}
                                value={member.role}
                                onChange={(event) => {
                                  const role = event.target.value;
                                  if (
                                    role === "admin" ||
                                    role === "organizer" ||
                                    role === "viewer"
                                  ) {
                                    void changeMemberRole(member, role);
                                  }
                                }}
                              >
                                <option value="organizer">Organizer</option>
                                <option value="viewer">View only</option>
                                <option value="admin">Admin</option>
                              </select>
                            </label>
                            <button className="text-button danger-text" onClick={() => void removeMember(member)} type="button">
                              Remove
                            </button>
                          </>
                        ) : (
                          <span className="role-pill">{member.role}</span>
                        )}
                      </div>
                      {isAdmin && dashboard.events.length > 0 && member.role !== "admin" && (
                        <div className="event-access-list">
                          <span>Event-specific access</span>
                          {dashboard.events.map((event) => {
                            const override = member.event_access.find(
                              (access) => access.event_id === event.id,
                            );
                            return (
                              <label key={event.id}>
                                <span>{event.title}</span>
                                <select
                                  aria-label={`${event.title} access for ${member.name}`}
                                  onChange={(change) =>
                                    void changeEventAccess(member, event.id, change.target.value)
                                  }
                                  value={override?.role ?? "default"}
                                >
                                  <option value="default">Use workspace role</option>
                                  <option value="organizer">Organizer</option>
                                  <option value="viewer">View only</option>
                                </select>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="management-empty">No team members yet.</div>
              )}
            </section>

            {isAdmin && (
              <section aria-labelledby="invitations-title" className="management-panel">
                <div className="management-section-heading">
                  <div>
                    <h2 id="invitations-title">Invitations</h2>
                    <p>Pending invitation links for this workspace.</p>
                  </div>
                </div>
                {invitations.filter((invitation) => !invitation.accepted_at).length ? (
                  <div className="invitation-list">
                    {invitations
                      .filter((invitation) => !invitation.accepted_at)
                      .map((invitation) => (
                        <div className="invitation-row" key={invitation.id}>
                          <span><strong>{invitation.email}</strong><small>{invitation.role} · expires {formatDate(invitation.expires_at)}</small></span>
                          {invitation.invite_url ? (
                            <button className="text-button" onClick={() => void copyInvitationLink(invitation)} type="button">
                              Copy link
                            </button>
                          ) : (
                            <span className="role-pill">Pending</span>
                          )}
                        </div>
                      ))}
                  </div>
                ) : (
                  <div className="management-empty">No pending invitations.</div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
