import { apiJson } from "./client";
import { acceptChannelInvite, declineChannelInvite } from "./channels";
import { acceptInvite, declineInvite } from "./workspaces";

/** One actionable item in the notification center (a pending invitation). */
export interface NotificationItem {
  kind: "workspace_invite" | "channel_invite";
  workspace_id: string;
  /** Present only for channel invites. */
  channel_id?: string | null;
  /** Display label: workspace name, or the channel name for channel invites. */
  title: string;
  invited_by?: string | null;
  invited_at?: string | null;
  role: string;
}

/** The caller's pending invitations (workspace + channel), newest first. */
export async function listNotifications(): Promise<NotificationItem[]> {
  return apiJson<NotificationItem[]>("/notifications");
}

/** Accept an invite of either kind, dispatching to the matching endpoint. */
export async function acceptNotification(n: NotificationItem): Promise<void> {
  if (n.kind === "channel_invite" && n.channel_id) {
    await acceptChannelInvite(n.channel_id);
  } else {
    await acceptInvite(n.workspace_id);
  }
}

/** Decline an invite of either kind. */
export async function declineNotification(n: NotificationItem): Promise<void> {
  if (n.kind === "channel_invite" && n.channel_id) {
    await declineChannelInvite(n.channel_id);
  } else {
    await declineInvite(n.workspace_id);
  }
}

/** Stable key for a notification (its underlying pending invite). */
export function notificationKey(n: NotificationItem): string {
  return n.kind === "channel_invite" ? `c:${n.channel_id}` : `w:${n.workspace_id}`;
}
