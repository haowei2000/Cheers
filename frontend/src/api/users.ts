import { apiJson } from "./client";
import type { User } from "@/types";

/** GET /users/me — the caller's own profile (status + bio beyond the login payload). */
export async function getMe(): Promise<User> {
  return apiJson<User>("/users/me");
}

/** Fields a user may self-edit. Omit a key to leave it unchanged; send "" to clear it. */
export interface UpdateMeInput {
  display_name?: string | null;
  bio?: string | null;
  avatar_url?: string | null;
  status_text?: string | null;
  status_emoji?: string | null;
}

/** PATCH /users/me — self-service profile + status edit. Returns the fresh profile. */
export async function updateMe(input: UpdateMeInput): Promise<User> {
  return apiJson<User>("/users/me", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

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
