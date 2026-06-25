import { apiFetch, apiJson } from "./client";

/** A bot in the channel whose connector can serve a remote workspace. */
export interface WorkspaceBot {
  bot_id: string;
  username: string;
  display_name: string | null;
  online: boolean;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
}

export interface WorkspaceTree {
  root: string;
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFile {
  root: string;
  path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  is_text: boolean;
  content: string | null;
  content_b64: string;
}

export async function listWorkspaceBots(channelId: string): Promise<WorkspaceBot[]> {
  const r = await apiJson<{ bots: WorkspaceBot[] }>(
    `/channels/${channelId}/workspace/bots`
  );
  return r.bots;
}

export async function getWorkspaceTree(
  channelId: string,
  botId: string,
  path = "",
  root?: string
): Promise<WorkspaceTree> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  return apiJson<WorkspaceTree>(`/channels/${channelId}/workspace/tree?${qs}`);
}

export async function getWorkspaceFile(
  channelId: string,
  botId: string,
  path: string,
  root?: string
): Promise<WorkspaceFile> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  return apiJson<WorkspaceFile>(`/channels/${channelId}/workspace/file?${qs}`);
}

export async function putWorkspaceFile(
  channelId: string,
  botId: string,
  path: string,
  content: string,
  root?: string
): Promise<void> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  const res = await apiFetch(`/channels/${channelId}/workspace/file?${qs}`, {
    method: "PUT",
    body: content,
  });
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
}

/** Where a clicked file reference actually lives (resolved by provenance, not syntax). */
export interface ResolvedRef {
  store: "inbox" | "desk" | "workspace" | "none";
  display_name: string;
  // inbox
  file_id?: string;
  content_type?: string | null;
  status?: string;
  // desk
  path?: string;
  content?: string | null;
  // workspace candidate
  bot_id?: string;
  also_in?: { store: string }[];
}

/**
 * Resolve a file reference clicked in a bot reply to the right store. Observational:
 * the gateway looks at what the bot actually produced in this channel; an unresolved
 * ref returns store:"none" (the UI then degrades gracefully — no 404).
 */
export async function resolveRef(
  channelId: string,
  ref: string,
  senderBotId?: string
): Promise<ResolvedRef> {
  return apiJson<ResolvedRef>(`/channels/${channelId}/resolve-ref`, {
    method: "POST",
    body: JSON.stringify({ ref, sender_bot_id: senderBotId }),
  });
}

/** Download arbitrary text content (e.g. a Desk file) as a file. */
export function downloadText(name: string, content: string, contentType = "text/plain"): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download from a fetched workspace file (text or base64 bytes). */
export function downloadWorkspaceFile(file: WorkspaceFile): void {
  let blob: Blob;
  if (file.is_text && file.content != null) {
    blob = new Blob([file.content], { type: file.content_type || "text/plain" });
  } else {
    const bin = atob(file.content_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: file.content_type || "application/octet-stream" });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}
