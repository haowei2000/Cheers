import { API_BASE, getAuthToken } from "../api";

export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export async function uploadAvatarImage(
  path: string,
  file: File,
  authToken: string | null,
): Promise<{ avatar_url: string; content_type?: string; size_bytes?: number }> {
  const headers: Record<string, string> = {};
  const token = authToken ?? getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (file.type) headers["Content-Type"] = file.type;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const res = await fetch(`${API_BASE}${suffix}`, {
    method: "POST",
    headers,
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.status === "error") {
    throw new Error(data?.message || data?.detail || "头像上传失败");
  }
  const payload = data?.data || data;
  if (!payload?.avatar_url) throw new Error("头像上传失败");
  return payload;
}
