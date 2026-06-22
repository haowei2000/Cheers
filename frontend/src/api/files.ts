import { apiJson } from "./client";
import type { FileInfo } from "@/types";

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
