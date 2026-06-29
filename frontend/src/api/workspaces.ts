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

export interface WorkspaceInvite {
  workspace_id: string;
  name: string;
  role: string;
  invited_by?: string | null;
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

/** Add a member directly (active immediately). Admin only. */
export async function addWorkspaceMember(
  workspaceId: string,
  member: { identifier: string; role?: string }
): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/members`, {
    method: "POST",
    body: JSON.stringify(member),
  });
}

/** Invite a member — creates a pending row the invitee must accept. Admin only. */
export async function inviteWorkspaceMember(
  workspaceId: string,
  member: { identifier: string; role?: string }
): Promise<{ status: string }> {
  return apiJson(`/workspaces/${workspaceId}/invite`, {
    method: "POST",
    body: JSON.stringify(member),
  });
}

export async function removeWorkspaceMember(
  workspaceId: string,
  userId: string
): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
}

/** The caller's pending workspace invites. */
export async function listMyInvites(): Promise<WorkspaceInvite[]> {
  return apiJson<WorkspaceInvite[]>("/workspaces/invites");
}

export async function acceptInvite(workspaceId: string): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/accept`, { method: "POST" });
}

export async function declineInvite(workspaceId: string): Promise<void> {
  await apiJson(`/workspaces/${workspaceId}/decline`, { method: "POST" });
}
