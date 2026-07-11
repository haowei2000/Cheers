import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Captions, FileText, Loader2 } from "lucide-react";
import toast from "react-hot-toast";
import { apiFetch } from "@/api/client";
import { realizeFile, pollFileStatus, transcribeFile } from "@/api/files";
import type { FileInfo } from "@/types";
import { downloadFile, formatBytes, isAudioFile } from "./fileUtils";
import { FileTypeIcon } from "./fileIcon";

// Click-gated: keeps pdfjs-dist (~364 kB) and the full highlight.js barrel out of the
// chat critical path — they download on first file-preview click. Named export → default shim.
const FilePreviewModal = lazy(() =>
  import("./FilePreviewModal").then((m) => ({ default: m.FilePreviewModal })),
);

// Shared rendering for CHAT files (file_records / S3 attachments) — distinct from workbench
// context_files. Used both inline in messages and in the channel Files dialog.

// Re-exported for callers that historically imported these from fileView.
export { downloadFile, formatBytes } from "./fileUtils";

// Inline image thumbnail. An <img src> can't carry the Bearer, so fetch the blob with auth
// then render an object URL (revoked on unmount). Clicking the tile opens the full preview.
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
      <div className="h-32 w-32 rounded-lg bg-zinc-800/60 flex items-center justify-center text-[10px] text-zinc-400">
        Loading image…
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={file.original_filename || "image"}
      className="max-h-48 max-w-[240px] rounded-lg object-cover hover:opacity-90 transition-opacity"
    />
  );
}

// Inline audio player. Like images, <audio src> can't carry the Bearer, so fetch
// the blob with auth and play an object URL. When the transcription worker has
// produced a transcript snippet (file.summary), show it under the player.
function AudioTile({ file }: { file: FileInfo }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.file_id]);

  return (
    <div className="flex max-w-[320px] flex-col gap-1 rounded-lg bg-zinc-800/60 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs text-zinc-200">
        <FileTypeIcon file={file} size={16} className="flex-shrink-0" />
        <span className="truncate" title={file.original_filename || file.file_id}>
          {file.original_filename || "audio"}
        </span>
        {typeof file.size_bytes === "number" && (
          <span className="flex-shrink-0 text-zinc-400">{formatBytes(file.size_bytes)}</span>
        )}
      </div>
      {failed ? (
        <button
          type="button"
          onClick={() => downloadFile(file)}
          title="Download this audio file"
          className="text-left text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          Playback unavailable — click to download
        </button>
      ) : src ? (
        <audio controls src={src} preload="metadata" className="h-9 w-full" />
      ) : (
        <div className="flex h-9 items-center gap-1.5 text-[11px] text-zinc-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading audio…
        </div>
      )}
      <TranscriptSection file={file} />
    </div>
  );
}

// Transcript area under the audio player: the snippet when transcription is
// done; a "Transcribe" button when never requested (opt-in per file); pending/failed
// states in between. `file.transcript_status` is kept live by the
// `file_transcribed` realtime frame; the local state only bridges the gap
// between clicking and the server acknowledging.
function TranscriptSection({ file }: { file: FileInfo }) {
  const [requested, setRequested] = useState(false);
  // A terminal-failure frame flips the tile back from "Transcribing" to the retry button.
  useEffect(() => {
    if (file.transcript_status === "failed") setRequested(false);
  }, [file.transcript_status]);

  if (file.summary) {
    return (
      <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-400">
        {file.summary}
      </p>
    );
  }

  const status = file.transcript_status;
  if (requested || status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin" /> Transcribing…
      </span>
    );
  }

  const request = () => {
    transcribeFile(file.file_id)
      .then(() => setRequested(true))
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Transcription request failed");
      });
  };

  return (
    <button
      type="button"
      onClick={request}
      title="Transcribe this audio to text"
      className="inline-flex w-fit items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
    >
      <Captions className="h-3 w-3" />
      {status === "failed" ? "Transcription failed — retry" : "Transcribe to text"}
    </button>
  );
}

// Staged file tile: click → realize → poll → auto-download when ready.
function StagedFileTile({ file }: { file: FileInfo }) {
  const [phase, setPhase] = useState<"idle" | "realizing" | "error">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => () => stopPoll(), []);

  const handleClick = useCallback(async () => {
    if (phase === "realizing") return;
    setPhase("realizing");
    try {
      await realizeFile(file.file_id);
    } catch {
      setPhase("error");
      return;
    }

    // Poll until uploaded (2 s interval, 60 s ceiling)
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      try {
        const status = await pollFileStatus(file.file_id);
        if (status === "uploaded") {
          stopPoll();
          setPhase("idle");
          await downloadFile({ ...file, status: "uploaded" });
        } else if (status === "expired" || attempts > 30) {
          stopPoll();
          setPhase("error");
        }
      } catch {
        stopPoll();
        setPhase("error");
      }
    }, 2000);
  }, [file, phase]);

  const label =
    phase === "realizing"
      ? "Loading…"
      : phase === "error"
        ? "Failed to load — click to retry"
        : file.original_filename || "Remote file";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={phase === "realizing"}
      title={file.original_filename || file.file_id}
      className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-zinc-600 bg-zinc-800/40 px-2.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors max-w-[240px] disabled:cursor-wait"
    >
      {phase === "realizing" ? (
        <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
      ) : (
        <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

// One file: an image thumbnail or a typed chip. Clicking either opens the preview modal
// (staged files keep their realize-then-download behavior instead).
export function FileTile({ file }: { file: FileInfo }) {
  const [open, setOpen] = useState(false);
  if (file.status === "staged") return <StagedFileTile file={file} />;

  const isImage = (file.content_type ?? "").startsWith("image/");
  if (isAudioFile(file)) return <AudioTile file={file} />;
  return (
    <>
      {isImage ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={file.original_filename || file.file_id}
          className="block rounded-lg transition-opacity hover:opacity-90"
        >
          <ImagePreview file={file} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={file.original_filename || file.file_id}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800/60 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700/70 transition-colors max-w-[240px]"
        >
          <FileTypeIcon file={file} size={16} className="flex-shrink-0" />
          <span className="truncate">{file.original_filename || "file"}</span>
          {typeof file.size_bytes === "number" && (
            <span className="text-zinc-400">{formatBytes(file.size_bytes)}</span>
          )}
        </button>
      )}
      {open && (
        <Suspense fallback={null}>
          <FilePreviewModal file={file} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

export function FileGrid({
  files,
  className = "",
  focusFileId,
}: {
  files: FileInfo[];
  className?: string;
  focusFileId?: string;
}) {
  const focusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (focusFileId && focusRef.current) {
      focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusFileId]);
  if (!files.length) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${className}`}>
      {files.map((f) => {
        const focused = f.file_id === focusFileId;
        return (
          <div
            key={f.file_id}
            ref={focused ? focusRef : undefined}
            className={focused ? "rounded-lg ring-2 ring-indigo-500/70 ring-offset-2 ring-offset-zinc-900" : undefined}
          >
            <FileTile file={f} />
          </div>
        );
      })}
    </div>
  );
}
