import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { apiFetch } from "@/api/client";
import type { FileInfo } from "@/types";

// Shared rendering for CHAT files (file_records / S3 attachments) — distinct from workbench
// context_files. Used both inline in messages and in the channel Files dialog.

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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

// Inline image preview. An <img src> can't carry the Bearer, so fetch the blob with auth
// then render an object URL (revoked on unmount).
function ImagePreview({ file }: { file: FileInfo }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    apiFetch(`/files/${file.file_id}/download`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("dl"))))
      .then((b) => {
        if (alive) {
          url = URL.createObjectURL(b);
          setSrc(url);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.file_id]);

  if (!src) {
    return (
      <div className="h-32 w-32 rounded-lg border border-zinc-700 bg-zinc-800/60 flex items-center justify-center text-[10px] text-zinc-500">
        加载图片…
      </div>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" title={file.original_filename || "image"}>
      <img
        src={src}
        alt={file.original_filename || "image"}
        className="max-h-48 max-w-[240px] rounded-lg border border-zinc-700 object-cover hover:opacity-90 transition-opacity"
      />
    </a>
  );
}

// One file: an inline image preview, or a download chip for everything else.
export function FileTile({ file }: { file: FileInfo }) {
  if ((file.content_type ?? "").startsWith("image/")) return <ImagePreview file={file} />;
  return (
    <button
      type="button"
      onClick={() => downloadFile(file)}
      title={file.original_filename || file.file_id}
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 transition-colors max-w-[240px]"
    >
      <FileText className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
      <span className="truncate">{file.original_filename || "file"}</span>
      {typeof file.size_bytes === "number" && (
        <span className="text-zinc-500">{formatBytes(file.size_bytes)}</span>
      )}
    </button>
  );
}

export function FileGrid({ files, className = "" }: { files: FileInfo[]; className?: string }) {
  if (!files.length) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {files.map((f) => (
        <FileTile key={f.file_id} file={f} />
      ))}
    </div>
  );
}
