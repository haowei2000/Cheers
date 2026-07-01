import { apiFetch } from "@/api/client";
import type { FileInfo } from "@/types";

// Shared helpers for CHAT files (file_records / S3 attachments). Kept in a plain
// module (no JSX) so both fileView.tsx and FilePreviewModal.tsx can import it
// without a circular dependency.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lower-cased extension without the dot, or "" when the filename has none. */
export function extOf(file: FileInfo): string {
  const name = file.original_filename ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export async function downloadFile(file: FileInfo) {
  // The download endpoint is JWT-protected, so fetch with auth then save a blob.
  try {
    const res = await apiFetch(`/files/${file.file_id}/download`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.original_filename || file.file_id;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    /* ignore download failures */
  }
}

// How a file renders in the in-app preview modal.
//  - image / pdf / markdown / text : rendered directly by the frontend
//  - office                        : needs a server-side PDF rendition (Phase 2, Gotenberg)
//  - none                          : no preview, download only
export type PreviewKind = "image" | "pdf" | "markdown" | "text" | "office" | "none";

const OFFICE_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
]);

// Extensions we render as plain text with syntax highlighting.
const TEXT_EXTS = new Set([
  "txt", "log", "csv", "json", "yaml", "yml", "toml", "ini", "conf", "env",
  "xml", "html", "css", "scss", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "py", "rs", "go", "java", "kt", "c", "cc", "cpp", "h", "hpp", "cs", "rb",
  "php", "swift", "sh", "bash", "zsh", "sql", "dockerfile", "makefile",
]);

export function previewKind(file: FileInfo): PreviewKind {
  const ct = (file.content_type ?? "").toLowerCase();
  const ext = extOf(file);
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  if (ct === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (
    OFFICE_EXTS.has(ext) ||
    ct.includes("officedocument") ||
    ct.includes("msword") ||
    ct.includes("ms-excel") ||
    ct.includes("ms-powerpoint") ||
    ct.includes("opendocument")
  ) {
    return "office";
  }
  if (ct.startsWith("text/") || TEXT_EXTS.has(ext)) return "text";
  return "none";
}
