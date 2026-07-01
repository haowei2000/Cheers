import { apiJson } from "./client";

export interface UserSearchResult {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}

/** Look up a single user by EXACT user id (friend-add is id-only; GET /friends/search?q=). */
export async function searchUsers(q: string): Promise<UserSearchResult[]> {
  return apiJson<UserSearchResult[]>(`/friends/search?q=${encodeURIComponent(q)}`);
}

export interface AdminUser {
  user_id: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  role: string;
  avatar_url?: string | null;
  is_suspended: boolean;
  created_at?: string | null;
}

/** Admin: list users, optionally filtered by name/username/email. */
export async function listUsers(q?: string): Promise<AdminUser[]> {
  const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return apiJson<AdminUser[]>(`/users${qs}`);
}

/** Admin: provision a new user account. */
export async function createUser(input: {
  username: string;
  password: string;
  display_name?: string;
  email?: string;
  role?: string;
}): Promise<{ user_id: string; username: string; role: string }> {
  return apiJson(`/users`, { method: "POST", body: JSON.stringify(input) });
}

/** Admin: soft-delete a user (frees username/email, revokes their tokens). */
export async function deleteUser(userId: string): Promise<void> {
  await apiJson(`/users/${userId}`, { method: "DELETE" });
}

/** Admin: revoke all sessions + block login until unsuspended (W6). */
export async function suspendUser(userId: string): Promise<void> {
  await apiJson(`/users/${userId}/suspend`, { method: "POST" });
}

/** Admin: lift a suspension (W6). */
export async function unsuspendUser(userId: string): Promise<void> {
  await apiJson(`/users/${userId}/unsuspend`, { method: "POST" });
}
