import { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import hljs from "highlight.js";
import { apiFetch } from "@/api/client";
import { getFileStatus } from "@/api/files";
import { Dialog } from "@/components/ui/dialog";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type { FileInfo } from "@/types";
import { downloadFile, extOf, formatBytes, previewKind } from "./fileUtils";
import { FileTypeIcon } from "./fileIcon";
import { PdfViewer } from "./PdfViewer";

const TEXT_CLIP = 256 * 1024; // cap what we highlight/render to keep the UI snappy

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

// Fetch a file's bytes (auth) as text, once, with loading/error state.
function useFileText(fileId: string): { state: "loading" | "ready" | "error"; text: string } {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [text, setText] = useState("");
  useEffect(() => {
    let alive = true;
    setState("loading");
    apiFetch(`/files/${fileId}/preview`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("dl"))))
      .then((t) => {
        if (!alive) return;
        setText(t.length > TEXT_CLIP ? t.slice(0, TEXT_CLIP) : t);
        setState("ready");
      })
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [fileId]);
  return { state, text };
}

function Centered({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "error" }) {
  return (
    <div
      className={`flex items-center justify-center gap-2 py-12 text-sm ${
        tone === "error" ? "text-rose-400" : "text-zinc-400"
      }`}
    >
      {children}
    </div>
  );
}

function ImageBody({ file }: { file: FileInfo }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    apiFetch(`/files/${file.file_id}/preview`)
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
  if (failed) return <Centered tone="error">Failed to load image</Centered>;
  if (!src) return <Centered><Loader2 className="h-4 w-4 animate-spin" /> Loading image…</Centered>;
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-zinc-950/40 p-2 text-center">
      <img src={src} alt={file.original_filename || "image"} className="mx-auto max-w-full rounded" />
    </div>
  );
}

function MarkdownBody({ file }: { file: FileInfo }) {
  const { state, text } = useFileText(file.file_id);
  if (state === "loading") return <Centered><Loader2 className="h-4 w-4 animate-spin" /> Loading…</Centered>;
  if (state === "error") return <Centered tone="error">Failed to load</Centered>;
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-zinc-950/40 p-4">
      <MarkdownRenderer content={text} />
    </div>
  );
}

function TextBody({ file }: { file: FileInfo }) {
  const { state, text } = useFileText(file.file_id);
  if (state === "loading") return <Centered><Loader2 className="h-4 w-4 animate-spin" /> Loading…</Centered>;
  if (state === "error") return <Centered tone="error">Failed to load</Centered>;
  const ext = extOf(file);
  let html: string;
  try {
    html =
      ext && hljs.getLanguage(ext)
        ? hljs.highlight(text, { language: ext }).value
        : hljs.highlightAuto(text).value;
  } catch {
    html = escapeHtml(text);
  }
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm leading-relaxed">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

// Office types have no client-side renderer. The gateway generates a PDF rendition
// (Gotenberg) asynchronously; poll `preview_ready`, then render that PDF.
function OfficeBody({ file }: { file: FileInfo }) {
  const [phase, setPhase] = useState<"pending" | "ready" | "failed">("pending");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const stop = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    const check = async () => {
      attempts++;
      try {
        const s = await getFileStatus(file.file_id);
        if (!alive) return;
        if (s.preview_ready) {
          setPhase("ready");
          stop();
        } else if (s.last_error || attempts > 60) {
          setPhase("failed");
          stop();
        }
      } catch {
        if (alive) {
          setPhase("failed");
          stop();
        }
      }
    };
    check();
    pollRef.current = setInterval(check, 2000);
    return () => {
      alive = false;
      stop();
    };
  }, [file.file_id]);

  if (phase === "ready") return <PdfViewer path={`/files/${file.file_id}/preview`} />;
  if (phase === "failed") return <UnsupportedBody file={file} office />;
  return (
    <Centered>
      <Loader2 className="h-4 w-4 animate-spin" /> Generating document preview…
    </Centered>
  );
}

function AudioBody({ file }: { file: FileInfo }) {
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
  if (failed) return <Centered tone="error">Failed to load audio</Centered>;
  if (!src) return <Centered><Loader2 className="h-4 w-4 animate-spin" /> Loading audio…</Centered>;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-zinc-950/40 p-4">
      <audio controls src={src} className="w-full" />
      {file.summary && (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-400">
          {file.summary}
        </p>
      )}
    </div>
  );
}

function UnsupportedBody({ file, office = false }: { file: FileInfo; office?: boolean }) {
  return (
    <Centered>
      <div className="flex flex-col items-center gap-3 text-center">
        <FileTypeIcon file={file} size={48} />
        <span>{office ? "Document preview isn't available yet — download to view." : "Preview isn't supported for this file type — download it instead."}</span>
      </div>
    </Centered>
  );
}

export function FilePreviewModal({ file, onClose }: { file: FileInfo; onClose: () => void }) {
  const kind = previewKind(file);
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <FileTypeIcon file={file} size={16} />
      <span className="truncate" title={file.original_filename || file.file_id}>
        {file.original_filename || file.file_id.slice(0, 8)}
      </span>
    </span>
  );
  return (
    <Dialog title={title} onClose={onClose} maxWidth="max-w-4xl">
      {kind === "image" && <ImageBody file={file} />}
      {kind === "pdf" && <PdfViewer path={`/files/${file.file_id}/preview`} />}
      {kind === "markdown" && <MarkdownBody file={file} />}
      {kind === "text" && <TextBody file={file} />}
      {kind === "audio" && <AudioBody file={file} />}
      {kind === "office" && <OfficeBody file={file} />}
      {kind === "none" && <UnsupportedBody file={file} />}
      <div className="flex items-center justify-between border-t border-zinc-800 pt-2 text-xs text-zinc-500">
        <span>{typeof file.size_bytes === "number" ? formatBytes(file.size_bytes) : ""}</span>
        <button
          type="button"
          onClick={() => downloadFile(file)}
          title="Download this file"
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-zinc-200 hover:bg-zinc-700"
        >
          <Download className="h-3.5 w-3.5" /> Download
        </button>
      </div>
    </Dialog>
  );
}
