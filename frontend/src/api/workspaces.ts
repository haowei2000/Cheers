import { apiJson } from "./client";
import type { Workspace } from "@/types";

export interface WorkspaceMember {
  user_id: string;
  username: string;
  display_name?: string | null;
  role: string;
  /** 'active' (joined) or 'pending' (invited, not yet accepted). */
  status: string;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return apiJson<Workspace[]>("/workspaces");
}

/** The caller's personal workspace (get-or-create) — their private space + DM anchor. */
export async function getPersonalWorkspace(): Promise<Workspace> {
  return apiJson<Workspace>("/workspaces/personal");
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return apiJson<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function updateWorkspace(
  workspaceId: string,
  patch: { name?: string; avatar_url?: string | null; default_bot_id?: string | null }
): Promise<Workspace> {
  return apiJson<Workspace>(`/workspaces/${workspaceId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}`, { method: "DELETE" });
}

export async function listWorkspaceMembers(
  workspaceId: string
): Promise<WorkspaceMember[]> {
  return apiJson<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`);
}

/** Invite a member — creates a pending row the invitee must accept. Admin only.
 *  (There is no consent-free "add directly" — every membership goes through this.) */
export async function inviteWorkspaceMember(
  workspaceId: string,
  member: { identifier: string; role?: string }
): Promise<{ status: string }> {
  return apiJson(`/workspaces/${workspaceId}/invite`, {
    method: "POST",
    body: JSON.stringify(member),
  });
}

/** A workspace-invite candidate; `membership` non-null means already in (or invited). */
export interface WorkspaceInvitable {
  user_id: string;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
  membership?: "active" | "pending" | null;
}

/**
 * Candidate search for the invite box (admin only). Privacy-preserving: substring
 * search matches only YOUR accepted friends; anyone else needs their EXACT
 * username or email (there is no site-wide directory to browse).
 */
export async function searchWorkspaceInvitable(
  workspaceId: string,
  q: string
): Promise<WorkspaceInvitable[]> {
  return apiJson<WorkspaceInvitable[]>(
    `/workspaces/${workspaceId}/invitable?q=${encodeURIComponent(q)}`
  );
}

export async function removeWorkspaceMember(
  workspaceId: string,
  userId: string
): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
}

/** Change a member's workspace role (admin only; refuses to demote the last owner). */
export async function setWorkspaceMemberRole(
  workspaceId: string,
  userId: string,
  role: string
): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

/** The caller leaves a workspace (any member except the last owner; not personal). */
export async function leaveWorkspace(workspaceId: string): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/leave`, { method: "POST" });
}

export async function acceptInvite(workspaceId: string): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/accept`, { method: "POST" });
}

export async function declineInvite(workspaceId: string): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/decline`, { method: "POST" });
}
