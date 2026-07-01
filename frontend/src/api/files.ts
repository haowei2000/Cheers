import { apiJson } from "./client";
import type { FileInfo } from "@/types";

/** The channel's chat files (file_records / S3 attachments) — its file library. */
export async function listChannelFiles(channelId: string): Promise<FileInfo[]> {
  return apiJson<FileInfo[]>(`/channels/${channelId}/files`);
}

/** Trigger lazy realize for a staged file. Returns { status: "realizing" }. */
export async function realizeFile(fileId: string): Promise<void> {
  await apiJson(`/files/${fileId}/realize`, { method: "POST" });
}

/** Poll the file's status. Returns the status string ("staged"|"realizing"|"uploaded"|"expired"). */
export async function pollFileStatus(fileId: string): Promise<string> {
  const res = await apiJson<{ status: string }>(`/files/${fileId}/status`);
  return res.status;
}

export interface FileStatus {
  status: string;
  /** True once an office doc's PDF preview rendition is ready (Gotenberg). */
  preview_ready?: boolean;
  last_error?: string | null;
}

/** Full status of a file — used to poll office→PDF preview readiness. */
export async function getFileStatus(fileId: string): Promise<FileStatus> {
  return apiJson<FileStatus>(`/files/${fileId}/status`);
}

/**
 * Gateway-proxied upload: the file bytes are sent as the request body and the
 * gateway streams them to object storage (SigV4) and records them as uploaded.
 * Returns the file ref to attach via `file_ids` on a message.
 */
export async function uploadFile(
  channelId: string,
  file: File
): Promise<FileInfo> {
  const ct = file.type || "application/octet-stream";
  const qs = new URLSearchParams({
    channel_id: channelId,
    filename: file.name,
    content_type: ct,
  });
  return apiJson<FileInfo>(`/files?${qs.toString()}`, {
    method: "POST",
    headers: { "Content-Type": ct },
    body: file,
  });
}
