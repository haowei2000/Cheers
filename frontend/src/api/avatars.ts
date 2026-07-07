import { apiJson } from "./client";

/**
 * Upload an avatar image (raw file bytes as the body, like uploadFile). The
 * gateway stores it and returns the public serving URL to drop into avatar_url.
 */
async function uploadAvatar(path: string, file: File): Promise<string> {
  const contentType = file.type || "application/octet-stream";
  const res = await apiJson<{ avatar_url: string }>(path, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: file,
  });
  return res.avatar_url;
}

/** Set the current user's avatar. Returns the new avatar_url. */
export function uploadUserAvatar(file: File): Promise<string> {
  return uploadAvatar("/users/me/avatar", file);
}

/** Set a bot's avatar (owner/admin). Returns the new avatar_url. */
export function uploadBotAvatar(botId: string, file: File): Promise<string> {
  return uploadAvatar(`/bots/${botId}/avatar`, file);
}
