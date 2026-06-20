import { apiJson } from "./client";
import type { Workspace } from "@/types";

export async function listWorkspaces(): Promise<Workspace[]> {
  return apiJson<Workspace[]>("/workspaces");
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return apiJson<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}
