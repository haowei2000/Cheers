import { apiJson } from "./client";
import { acceptChannelInvite, declineChannelInvite } from "./channels";
import { acceptBotChannelInvite, declineBotChannelInvite } from "./channels";
import { acceptInvite, declineInvite } from "./workspaces";
import { acceptFriendRequest, cancelFriendRequest } from "./friends";

/** One actionable item in the notification center (a pending invitation). */
export interface NotificationItem {
  id: string;
  kind:
    | "friend_request"
    | "workspace_invite"
    | "channel_invite"
    | "bot_channel_invite";
  title: string;
  actor_id?: string | null;
  actor_name?: string | null;
  created_at?: string | null;
  friendship_id?: string | null;
  workspace_id?: string | null;
  channel_id?: string | null;
  requester_user_id?: string | null;
  bot_id?: string | null;
  bot_name?: string | null;
  role?: string | null;
  requested_cwd?: string | null;
  requested_additional_dirs?: string[];
}

/** The caller's pending invitations (workspace + channel), newest first. */
export async function listNotifications(): Promise<NotificationItem[]> {
  return apiJson<NotificationItem[]>("/notifications");
}

/** Accept an invite of either kind, dispatching to the matching endpoint. */
export async function acceptNotification(n: NotificationItem): Promise<void> {
  if (n.kind === "friend_request" && n.requester_user_id) {
    await acceptFriendRequest(n.requester_user_id);
  } else if (n.kind === "bot_channel_invite" && n.channel_id && n.bot_id) {
    await acceptBotChannelInvite(n.channel_id, n.bot_id);
  } else if (n.kind === "channel_invite" && n.channel_id) {
    await acceptChannelInvite(n.channel_id);
  } else if (n.kind === "workspace_invite" && n.workspace_id) {
    await acceptInvite(n.workspace_id);
  } else {
    throw new Error("This activity item is no longer actionable");
  }
}

/** Decline an invite of either kind. */
export async function declineNotification(n: NotificationItem): Promise<void> {
  if (n.kind === "friend_request" && n.friendship_id) {
    await cancelFriendRequest(n.friendship_id);
  } else if (n.kind === "bot_channel_invite" && n.channel_id && n.bot_id) {
    await declineBotChannelInvite(n.channel_id, n.bot_id);
  } else if (n.kind === "channel_invite" && n.channel_id) {
    await declineChannelInvite(n.channel_id);
  } else if (n.kind === "workspace_invite" && n.workspace_id) {
    await declineInvite(n.workspace_id);
  } else {
    throw new Error("This activity item is no longer actionable");
  }
}

/** Stable key for a notification (its underlying pending invite). */
export function notificationKey(n: NotificationItem): string {
  return n.id;
}
