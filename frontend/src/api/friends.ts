import { apiJson } from "./client";
import { searchUsers, type UserSearchResult } from "./users";

export interface Friend {
  friendship_id: string;
  friend_id: string;
  status: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  is_bot?: boolean;
}

export interface FriendRequestItem {
  friendship_id: string;
  /** The other party (requester for incoming, target for outgoing). */
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  direction: "incoming" | "outgoing";
  message?: string | null;
  created_at?: string | null;
  is_bot?: boolean;
  target_bot_id?: string | null;
  target_bot_name?: string | null;
}

export interface FriendActionResult {
  friend_id: string;
  status: string;
  channel_id?: string | null;
  is_bot?: boolean;
}

export function listFriends(): Promise<Friend[]> {
  return apiJson<Friend[]>("/friends");
}

/** Send a friend request (auto-accepts if the other user already requested me). */
export function sendFriendRequest(
  friendId: string,
  message?: string
): Promise<FriendActionResult> {
  return apiJson<FriendActionResult>("/friends", {
    method: "POST",
    body: JSON.stringify({ friend_id: friendId, message }),
  });
}

/** Remove an accepted friend relationship. */
export function removeFriend(friendId: string): Promise<{ removed: boolean }> {
  return apiJson<{ removed: boolean }>(
    `/friends?friend_id=${encodeURIComponent(friendId)}`,
    { method: "DELETE" }
  );
}

/** Decline or cancel one exact pending request. Stale calls are harmless. */
export function cancelFriendRequest(
  friendshipId: string
): Promise<{ removed: boolean }> {
  return apiJson<{ removed: boolean }>(
    `/friends/requests/${encodeURIComponent(friendshipId)}`,
    { method: "DELETE" }
  );
}

export function listFriendRequests(
  direction: "incoming" | "outgoing"
): Promise<FriendRequestItem[]> {
  return apiJson<FriendRequestItem[]>(`/friends/requests?direction=${direction}`);
}

export function acceptFriendRequest(
  userId: string,
  botId?: string
): Promise<FriendActionResult> {
  const query = botId ? `?bot_id=${encodeURIComponent(botId)}` : "";
  return apiJson<FriendActionResult>(
    `/friends/requests/${encodeURIComponent(userId)}/accept${query}`,
    { method: "POST" }
  );
}

export interface BlockedUser {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

export function blockUser(
  userId: string
): Promise<{ user_id: string; blocked: boolean }> {
  return apiJson("/friends/block", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export function unblockUser(
  userId: string
): Promise<{ user_id: string; blocked: boolean }> {
  return apiJson("/friends/unblock", {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
}

export function listBlocks(): Promise<BlockedUser[]> {
  return apiJson<BlockedUser[]>("/friends/blocks");
}

export { searchUsers };
export type { UserSearchResult };
