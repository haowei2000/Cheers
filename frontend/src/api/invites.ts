import { apiJson } from "./client";

/** A shareable workspace invite link (admin-managed). */
export interface InviteLink {
  link_id: string;
  /** Bearer token — render as `${location.origin}/invite/${token}`. */
  token: string;
  workspace_id: string;
  channel_id: string | null;
  channel_name: string | null;
  created_by: string | null;
  created_at: string | null;
  expires_at: string | null;
  max_uses: number | null;
  use_count: number;
  status: "active" | "expired" | "exhausted";
}

/** Public landing-page preview. Workspace details are present only while valid. */
export interface InviteLinkPreview {
  status: "valid" | "expired" | "exhausted";
  workspace_id?: string;
  workspace_name?: string;
  workspace_avatar_url?: string | null;
  channel_id?: string;
  channel_name?: string;
  inviter?: string;
  member_count?: number;
}

export interface AcceptInviteResult {
  workspace_id: string;
  channel_id: string | null;
  channel_joined: boolean;
  already_member: boolean;
  status: string;
}

/** Mint a shareable link (workspace admin). Omitted fields = never expires / unlimited. */
export async function createInviteLink(
  workspaceId: string,
  input: { expires_in_hours?: number | null; max_uses?: number | null; channel_id?: string | null }
): Promise<InviteLink> {
  return apiJson<InviteLink>(`/workspaces/${workspaceId}/invite-links`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Every non-revoked link of the workspace, newest first (workspace admin). */
export async function listInviteLinks(workspaceId: string): Promise<InviteLink[]> {
  return apiJson<InviteLink[]>(`/workspaces/${workspaceId}/invite-links`);
}

/** Revoke a link — the shared URL stops working immediately. */
export async function revokeInviteLink(
  workspaceId: string,
  linkId: string
): Promise<{ revoked: boolean }> {
  return apiJson(`/workspaces/${workspaceId}/invite-links/${linkId}`, { method: "DELETE" });
}

/** Public preview for the /invite/:token landing page (no auth needed). */
export async function getInvitePreview(token: string): Promise<InviteLinkPreview> {
  return apiJson<InviteLinkPreview>(`/invite-links/${token}`);
}

/** Redeem a link as the signed-in user: joins the workspace (and the link's
 *  public channel, if any). Idempotent for existing members. */
export async function acceptInviteLink(token: string): Promise<AcceptInviteResult> {
  return apiJson<AcceptInviteResult>(`/invite-links/${token}/accept`, { method: "POST" });
}

/** Compose the shareable URL for a link token. */
export function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}
