import { Button as UiButton } from "@/components/ui/button";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Captions, Download, Eye, FileText, Loader2, Paperclip } from "lucide-react";
import toast from "react-hot-toast";
import { apiFetch } from "@/api/client";
import { transcribeFile } from "@/api/files";
import type { FileInfo } from "@/types";
import { downloadFile, formatBytes, isAudioFile } from "./fileUtils";
import { FileTypeIcon } from "./fileIcon";
import { useContextSurface } from "@/components/ui/context-actions";
import { useContextPickStore } from "./context/contextPick";

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
      <div className="h-32 w-32 rounded-sm bg-zinc-800/60 flex items-center justify-center text-minimal text-content-muted">
        Loading image…
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={file.original_filename || "image"}
      className="max-h-48 max-w-[240px] rounded-sm object-cover hover:opacity-90 transition-opacity"
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
    <div className="flex max-w-[320px] flex-col gap-1 rounded-sm bg-zinc-800/60 px-3 py-2">
      <div className="flex items-center gap-2 text-compact text-content-secondary">
        <FileTypeIcon file={file} size={16} className="flex-shrink-0" />
        <span className="truncate" title={file.original_filename || file.file_id}>
          {file.original_filename || "audio"}
        </span>
        {typeof file.size_bytes === "number" && (
          <span className="flex-shrink-0 text-content-muted">{formatBytes(file.size_bytes)}</span>
        )}
      </div>
      {failed ? (
        <UiButton action="download" variant="plain"
          type="button"
          onClick={() => downloadFile(file)}
          title="Download this audio file"
          className="text-left  text-content-primary hover:text-content-strong"
        >
          Playback unavailable — click to download
        </UiButton>
      ) : src ? (
        <audio controls src={src} preload="metadata" className="h-9 w-full" />
      ) : (
        <div className="flex h-9 items-center gap-2 text-compact text-content-muted">
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
      <p className="whitespace-pre-wrap break-words text-compact leading-reading text-content-muted">
        {file.summary}
      </p>
    );
  }

  const status = file.transcript_status;
  if (requested || status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 text-compact text-content-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Transcribing…
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
    /* design-system-exempt: drop-zone */
    <UiButton action="transcribe" content="iconText" variant="plain"
      type="button"
      onClick={request}
      title="Transcribe this audio to text"
      className="inline-flex items-center gap-1  text-content-primary hover:text-content-strong transition-colors"
    >
      <Captions className="h-3.5 w-3.5" />
      {status === "failed" ? "Transcription failed — retry" : "Transcribe to text"}
    </UiButton>
  );
}

// Historical staged attachments have no durable object after the Connector-side
// realization path was retired. Keep the record visible, but never offer an action
// that can no longer succeed.
function UnavailableFileTile({ file }: { file: FileInfo }) {
  return (
    /* design-system-exempt: drop-zone */
    <div
      role="status"
      title={file.original_filename || file.file_id}
      className="inline-flex max-w-[240px] items-center gap-2 rounded-sm border border-dashed border-zinc-700 bg-zinc-900/40 px-3 py-2 text-content-muted"
      data-design-system-exempt="drop-zone"
    >
      <FileText className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="min-w-0">
        <span className="block truncate">{file.original_filename || "Remote file"}</span>
        <span className="block text-minimal">Attachment unavailable</span>
      </span>
    </div>
  );
}

// One durable file: an image thumbnail or a typed chip. Historical non-uploaded
// records remain visible as unavailable metadata and cannot trigger realization.
export function FileTile({ file, channelId }: { file: FileInfo; channelId?: string }) {
  const [open, setOpen] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const addContext = useContextPickStore((state) => state.add);
  const durable = !file.status || ["uploaded", "converted"].includes(file.status);
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => durable ? [
      { id: "preview", label: "Open preview", icon: <Eye className="h-4 w-4" />, run: () => setOpen(true) },
      { id: "download", label: "Download", icon: <Download className="h-4 w-4" />, run: () => downloadFile(file) },
      ...(channelId ? [{
        id: "context",
        label: "Add file to context",
        icon: <Paperclip className="h-4 w-4" />,
        group: "secondary" as const,
        run: () => addContext(channelId, {
          id: `file:${file.file_id}`,
          verb: "channel.files.read",
          params: { file_id: file.file_id },
          label: file.original_filename || file.file_id,
          kind: "file",
        }),
      }] : []),
    ] : [],
  });
  if (file.status && !["uploaded", "converted"].includes(file.status)) {
    return <UnavailableFileTile file={file} />;
  }

  const isImage = (file.content_type ?? "").startsWith("image/");
  return (
    // Context-menu gestures are delegated to the file tile's native controls.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={surfaceRef}
      role="group"
      tabIndex={-1}
      onContextMenu={contextSurface.onContextMenu}
      onKeyDown={contextSurface.onKeyDown}
      onPointerDown={contextSurface.onPointerDown}
      onPointerMove={contextSurface.onPointerMove}
      onPointerUp={contextSurface.onPointerUp}
      onPointerCancel={contextSurface.onPointerCancel}
      onPointerLeave={contextSurface.onPointerLeave}
      onClickCapture={contextSurface.onClickCapture}
    >
      {isAudioFile(file) ? (
        <AudioTile file={file} />
      ) : isImage ? (
        <UiButton variant="plain" role="option"
          type="button"
          onClick={() => setOpen(true)}
          title={file.original_filename || file.file_id}
          className="block rounded-sm transition-opacity hover:opacity-90"
        >
          <ImagePreview file={file} />
        </UiButton>
      ) : (
        <UiButton content="iconText" variant="plain" role="option"
          type="button"
          onClick={() => setOpen(true)}
          title={file.original_filename || file.file_id}
          controlSize="regular" className="inline-flex items-center gap-2 rounded-sm bg-zinc-800/60  text-content-primary hover:bg-zinc-700/70 transition-colors max-w-[240px]"
        >
          <FileTypeIcon file={file} size={16} className="flex-shrink-0" />
          <span className="truncate">{file.original_filename || "file"}</span>
          {typeof file.size_bytes === "number" && (
            <span className="text-content-muted">{formatBytes(file.size_bytes)}</span>
          )}
        </UiButton>
      )}
      {open && (
        <Suspense fallback={null}>
          <FilePreviewModal file={file} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

export function FileGrid({
  files,
  className = "",
  focusFileId,
  channelId,
}: {
  files: FileInfo[];
  className?: string;
  focusFileId?: string;
  channelId?: string;
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
            className={focused ? "rounded-sm ring-2 ring-indigo-500/70 ring-offset-2 ring-offset-zinc-900" : undefined}
          >
            <FileTile file={f} channelId={channelId} />
          </div>
        );
      })}
    </div>
  );
}
