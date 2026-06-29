import { apiJson } from "./client";
import { searchUsers, type UserSearchResult } from "./users";

export interface Friend {
  friendship_id: string;
  friend_id: string;
  status: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

export interface FriendRequestItem {
  friendship_id: string;
  /** The other party (requester for incoming, target for outgoing). */
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  direction: "incoming" | "outgoing";
}

export interface FriendActionResult {
  friend_id: string;
  status: string;
}

export function listFriends(): Promise<Friend[]> {
  return apiJson<Friend[]>("/friends");
}

/** Send a friend request (auto-accepts if the other user already requested me). */
export function sendFriendRequest(friendId: string): Promise<FriendActionResult> {
  return apiJson<FriendActionResult>("/friends", {
    method: "POST",
    body: JSON.stringify({ friend_id: friendId }),
  });
}

/** Remove a friend, cancel an outgoing request, or decline an incoming one. */
export function removeFriend(friendId: string): Promise<{ removed: boolean }> {
  return apiJson<{ removed: boolean }>(
    `/friends?friend_id=${encodeURIComponent(friendId)}`,
    { method: "DELETE" }
  );
}

export function listFriendRequests(
  direction: "incoming" | "outgoing"
): Promise<FriendRequestItem[]> {
  return apiJson<FriendRequestItem[]>(`/friends/requests?direction=${direction}`);
}

export function acceptFriendRequest(userId: string): Promise<FriendActionResult> {
  return apiJson<FriendActionResult>(
    `/friends/requests/${encodeURIComponent(userId)}/accept`,
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
