import { apiJson } from "./client";

export interface UserSearchResult {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

/** Search users by username / display name / email (GET /friends/search?q=). */
export async function searchUsers(q: string): Promise<UserSearchResult[]> {
  return apiJson<UserSearchResult[]>(`/friends/search?q=${encodeURIComponent(q)}`);
}

/** Admin: revoke all sessions + block login until unsuspended (W6). */
export async function suspendUser(userId: string): Promise<void> {
  await apiJson(`/users/${userId}/suspend`, { method: "POST" });
}

/** Admin: lift a suspension (W6). */
export async function unsuspendUser(userId: string): Promise<void> {
  await apiJson(`/users/${userId}/unsuspend`, { method: "POST" });
}
