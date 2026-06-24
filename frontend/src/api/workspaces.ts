import { apiJson } from "./client";
import type { Workspace } from "@/types";

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
