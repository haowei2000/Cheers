import { apiFetch } from "../api/client";

export const AGENTNEXUS_FILE_URL_RE =
  /(?:https?:\/\/[^/]+)?\/api\/(?:v1\/)?files\/([^/]+)\/(preview|download|content)/;

export function isAgentNexusFileUrl(url: string): boolean {
  return AGENTNEXUS_FILE_URL_RE.test(url);
}

async function buildProtectedFileError(res: Response): Promise<Error> {
  let message = "";
  try {
    const payload = await res.clone().json();
    if (payload && typeof payload === "object" && "message" in payload) {
      message = String((payload as { message?: unknown }).message ?? "");
    }
  } catch {
    // Non-JSON file errors fall back to status-specific copy below.
  }
  if (!message) {
    if (res.status === 404) message = "File does not exist, has expired, or was cleaned up";
    else if (res.status === 401 || res.status === 403) message = "You do not have permission to preview this file";
    else message = `File preview failed to load (HTTP ${res.status})`;
  }
  const error = new Error(message);
  error.name = "ProtectedFileError";
  return error;
}

export async function fetchProtectedFileBlob(url: string): Promise<Blob> {
  const res = await apiFetch(url);
  if (!res.ok) throw await buildProtectedFileError(res);
  return res.blob();
}

export async function createProtectedFileObjectUrl(url: string): Promise<string> {
  const blob = await fetchProtectedFileBlob(url);
  return URL.createObjectURL(blob);
}

export async function downloadProtectedFile(url: string, filename: string): Promise<void> {
  const objectUrl = await createProtectedFileObjectUrl(url);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export async function openProtectedFile(url: string): Promise<void> {
  const opened = window.open("", "_blank");
  if (opened) opened.opener = null;
  try {
    const objectUrl = await createProtectedFileObjectUrl(url);
    if (opened) opened.location.href = objectUrl;
    else window.open(objectUrl, "_blank", "noreferrer");
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    if (opened) opened.close();
    throw error;
  }
}
