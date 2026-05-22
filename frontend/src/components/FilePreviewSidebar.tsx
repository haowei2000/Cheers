import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { MessageMarkdown } from "../MessageMarkdown";
import { apiFetch } from "../api/client";
import {
  createProtectedFileObjectUrl,
  downloadProtectedFile,
  openProtectedFile,
} from "../lib/protected-file";
import type { FileInfo } from "../types";
import { AppIcon } from "./icons/AppIcon";
import { FileTypeIcon } from "./icons/FileTypeIcon";
import { Tooltip } from "./Tooltip";

type TextPreviewKind = "html" | "markdown" | "text";
const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
const KKFILEVIEW_REFRESH_SKEW_MS = 30_000;
const KKFILEVIEW_EXTS = new Set([
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "wps",
  "et",
  "dps",
  "ofd",
  "rtf",
  "csv",
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "bz2",
  "xz",
  "dwg",
  "dxf",
  "epub",
]);

type KkViewerState = {
  url: string;
  expiresAtMs: number | null;
};

function swapFileAction(url: string, action: "preview" | "download" | "content") {
  const [base, query] = url.split("?");
  const next = base.replace(/\/(preview|download|content)$/, `/${action}`);
  return query ? `${next}?${query}` : next;
}

function extractFileId(url: string): string | null {
  const match = url.match(/\/files\/([^/?]+)\/(?:preview|download|content)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function FilePreviewPanel({
  url,
  filename,
  contentType,
  sizeBytes,
  subtitle,
  fileId,
  channelId,
  scopeType,
  scopeId,
  source,
  onDeleted,
  onAttachFile,
  onClose,
  variant = "side",
}: {
  url: string;
  filename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  subtitle?: string | null;
  fileId?: string;
  channelId?: string | null;
  scopeType?: string | null;
  scopeId?: string | null;
  source?: "message" | "memory" | "personal";
  onDeleted?: () => void;
  onAttachFile?: (file: FileInfo) => void;
  onClose: () => void;
  variant?: "side" | "main";
}) {
  const previewUrl = swapFileAction(url, "preview");
  const downloadUrl = swapFileAction(url, "download");
  const contentUrl = swapFileAction(url, "content");
  const resolvedFileId = fileId || extractFileId(previewUrl);
  const canDelete = Boolean(
    resolvedFileId &&
      (channelId || (scopeType && scopeId) || source === "personal"),
  );
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const normalizedType = (contentType ?? "").split(";", 1)[0].toLowerCase();
  const isImage =
    normalizedType.startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
  const isPdf = normalizedType.includes("pdf") || ext === "pdf";
  const isHtml =
    normalizedType === "text/html" ||
    normalizedType === "application/xhtml+xml" ||
    ["html", "htm"].includes(ext);
  const isMarkdown =
    normalizedType === "text/markdown" || ext === "md" || ext === "markdown";
  const isPlainText = normalizedType === "text/plain" || ext === "txt";
  const isExtractedPreview =
    ["docx", "xlsx"].includes(ext) ||
    normalizedType.includes("wordprocessingml") ||
    normalizedType.includes("spreadsheetml");
  const isKkFileViewDocument =
    !isImage &&
    !isPdf &&
    !isHtml &&
    !isMarkdown &&
    (KKFILEVIEW_EXTS.has(ext) ||
      normalizedType.includes("wordprocessingml") ||
      normalizedType.includes("spreadsheetml") ||
      normalizedType.includes("presentationml") ||
      normalizedType === "application/msword" ||
      normalizedType === "application/vnd.ms-excel" ||
      normalizedType === "application/vnd.ms-powerpoint" ||
      normalizedType === "application/ofd" ||
      normalizedType === "application/rtf");
  const sizeLabel =
    sizeBytes && sizeBytes > 0
      ? sizeBytes < 1024
        ? `${sizeBytes} B`
        : sizeBytes < 1024 * 1024
          ? `${(sizeBytes / 1024).toFixed(1)} KB`
          : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : "";
  const subtitleLabel = [subtitle, sizeLabel].filter(Boolean).join(" · ");

  const [textContent, setTextContent] = useState<string | null>(null);
  const [textKind, setTextKind] = useState<TextPreviewKind>(
    isHtml ? "html" : isMarkdown || ext === "xlsx" ? "markdown" : "text",
  );
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [binaryPreviewUrl, setBinaryPreviewUrl] = useState<string | null>(null);
  const [binaryLoading, setBinaryLoading] = useState(false);
  const [binaryError, setBinaryError] = useState<string | null>(null);
  const [kkViewer, setKkViewer] = useState<KkViewerState | null>(null);
  const [kkLoading, setKkLoading] = useState(false);
  const [kkError, setKkError] = useState<string | null>(null);
  const [kkFallbackToText, setKkFallbackToText] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const shouldUseKkFileView = isKkFileViewDocument && !kkFallbackToText;
  const kkViewerUrl = kkViewer?.url ?? null;
  const shouldLoadText =
    !shouldUseKkFileView &&
    !isImage &&
    !isPdf &&
    !isHtml &&
    (isMarkdown || isPlainText || isExtractedPreview);

  const loadKkViewer = useCallback(async (signal?: AbortSignal): Promise<KkViewerState> => {
    const fileId = extractFileId(previewUrl);
    if (!fileId) {
      throw new Error("Could not identify the file preview URL");
    }
    const response = await apiFetch(`/files/${encodeURIComponent(fileId)}/kkfileview`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const data = payload?.data ?? payload;
    if (!data?.enabled || !data?.viewer_url) {
      throw new Error(data?.reason || "Document preview service is unavailable");
    }
    const expiresIn = Number(data.expires_in);
    return {
      url: String(data.viewer_url),
      expiresAtMs: Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : null,
    };
  }, [previewUrl]);

  useEffect(() => {
    setKkFallbackToText(false);
  }, [contentType, filename, previewUrl]);

  useEffect(() => {
    if (!shouldLoadText) {
      setTextContent(null);
      setTextError(null);
      setTextLoading(false);
      return;
    }

    const sourceUrl = isExtractedPreview ? contentUrl : previewUrl;
    setTextLoading(true);
    setTextContent(null);
    setTextError(null);
    apiFetch(sourceUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return isExtractedPreview ? r.json() : r.text();
      })
      .then((payload) => {
        if (isExtractedPreview) {
          const data = payload?.data ?? payload;
          if (data?.preview_type === "unsupported") {
            throw new Error(data.error || "This file cannot be previewed yet");
          }
          setTextKind(data?.preview_type === "markdown" ? "markdown" : "text");
          setTextContent(String(data?.content ?? ""));
        } else {
          setTextKind(isMarkdown ? "markdown" : "text");
          setTextContent(String(payload ?? ""));
        }
        setTextLoading(false);
      })
      .catch((e) => {
        setTextError(e instanceof Error ? e.message : String(e));
        setTextLoading(false);
      });
  }, [contentUrl, isExtractedPreview, isMarkdown, previewUrl, shouldLoadText]);

  useEffect(() => {
    if (!isKkFileViewDocument) {
      setKkViewer(null);
      setKkError(null);
      setKkLoading(false);
      return;
    }
    if (kkFallbackToText) {
      setKkViewer(null);
      setKkLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setKkLoading(true);
    setKkError(null);
    setKkViewer(null);
    loadKkViewer(controller.signal)
      .then((next) => {
        if (cancelled) return;
        setKkViewer(next);
        setKkLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof DOMException && e.name === "AbortError") return;
        setKkError(e instanceof Error ? e.message : String(e));
        setKkLoading(false);
        setKkFallbackToText(true);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isKkFileViewDocument, kkFallbackToText, loadKkViewer]);

  useEffect(() => {
    if (!shouldUseKkFileView || !kkViewer?.expiresAtMs) return;
    const delay = Math.max(0, kkViewer.expiresAtMs - Date.now() - KKFILEVIEW_REFRESH_SKEW_MS);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      loadKkViewer()
        .then((next) => {
          if (!cancelled) {
            setKkViewer(next);
            setKkError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setKkError(e instanceof Error ? e.message : String(e));
            setKkFallbackToText(true);
          }
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [kkViewer?.expiresAtMs, loadKkViewer, shouldUseKkFileView]);

  useEffect(() => {
    if (!isImage && !isPdf && !isHtml) {
      setBinaryPreviewUrl(null);
      setBinaryError(null);
      setBinaryLoading(false);
      return;
    }

    let revoked = false;
    let objectUrl: string | null = null;
    setBinaryLoading(true);
    setBinaryError(null);
    setBinaryPreviewUrl(null);
    createProtectedFileObjectUrl(previewUrl)
      .then((url) => {
        objectUrl = url;
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        setBinaryPreviewUrl(url);
        setBinaryLoading(false);
      })
      .catch((e) => {
        setBinaryError(e instanceof Error ? e.message : String(e));
        setBinaryLoading(false);
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isHtml, isImage, isPdf, previewUrl]);

  const handleDownload = () => {
    downloadProtectedFile(downloadUrl, filename).catch((e) => {
      setBinaryError(e instanceof Error ? e.message : String(e));
    });
  };

  const handleOpen = () => {
    if (shouldUseKkFileView) {
      const current = kkViewer;
      if (
        current?.url &&
        (!current.expiresAtMs || current.expiresAtMs - Date.now() > KKFILEVIEW_REFRESH_SKEW_MS)
      ) {
        window.open(current.url, "_blank", "noreferrer");
        return;
      }
      const opened = window.open("", "_blank", "noreferrer");
      if (opened) opened.opener = null;
      loadKkViewer()
        .then((next) => {
          setKkViewer(next);
          setKkError(null);
          if (opened) opened.location.href = next.url;
          else window.open(next.url, "_blank", "noreferrer");
        })
        .catch((e) => {
          if (opened) opened.close();
          setKkError(e instanceof Error ? e.message : String(e));
        });
      return;
    }
    openProtectedFile(previewUrl).catch((e) => {
      setBinaryError(e instanceof Error ? e.message : String(e));
    });
  };

  const handleAttachFile = () => {
    if (!resolvedFileId) return;
    onAttachFile?.({
      file_id: resolvedFileId,
      original_filename: filename,
      content_type: contentType ?? undefined,
      size_bytes: sizeBytes ?? undefined,
      channel_id: channelId ?? undefined,
      scope_type: scopeType,
      scope_id: scopeId,
    });
  };

  const handleDelete = async () => {
    if (!resolvedFileId || deleting) return;
    if (!confirm(`Delete ${filename}?`)) return;
    setDeleting(true);
    try {
      const params = new URLSearchParams();
      if (channelId) {
        params.set("channel_id", channelId);
      } else if (scopeType && scopeId) {
        params.set("scope_type", scopeType);
        params.set("scope_id", scopeId);
      }
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const response = await apiFetch(
        `/files/${encodeURIComponent(resolvedFileId)}${suffix}`,
        { method: "DELETE" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.message || payload?.detail || "Delete failed");
      }
      toast.success("File deleted");
      onDeleted?.();
      onClose();
    } catch (error: unknown) {
      toast.error((error as Error).message || "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  const Root = variant === "main" ? "section" : "aside";

  return (
    <Root className={`an-file-preview is-${variant}`}>
      <div className="an-file-preview-head">
        <div className="an-file-preview-icon">
          <FileTypeIcon contentType={contentType} filename={filename} size={20} />
        </div>
        <Tooltip
          className="an-file-preview-title-wrap"
          content={filename}
          placement="bottom"
        >
          <div className="an-file-preview-title">
            <strong>{filename}</strong>
            {subtitleLabel && <span>{subtitleLabel}</span>}
          </div>
        </Tooltip>
        <div className="an-file-preview-actions">
          <Tooltip content="Download file" placement="bottom">
            <button
              type="button"
              onClick={handleDownload}
              className="an-file-preview-action"
              aria-label="Download file"
            >
              <AppIcon name="download" />
            </button>
          </Tooltip>
          <Tooltip content="Open in a new tab" placement="bottom">
            <button
              type="button"
              onClick={handleOpen}
              className="an-file-preview-action"
              aria-label="Open in a new tab"
            >
              <AppIcon name="externalLink" />
            </button>
          </Tooltip>
          {resolvedFileId && onAttachFile && (
            <Tooltip content="Copy to composer" placement="bottom">
              <button
                type="button"
                onClick={handleAttachFile}
                className="an-file-preview-action"
                aria-label="Copy to composer"
              >
                <AppIcon name="copy" />
              </button>
            </Tooltip>
          )}
          {canDelete && (
            <Tooltip content="Delete file" placement="bottom">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="an-file-preview-action"
                aria-label="Delete file"
              >
                <AppIcon name="trash" />
              </button>
            </Tooltip>
          )}
          <Tooltip content="ClosePreview" placement="bottom">
            <button
              type="button"
              onClick={onClose}
              className="an-file-preview-action"
              aria-label="ClosePreview"
            >
              <AppIcon name="close" />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="an-file-preview-body">
        {isImage ? (
          <div className="an-file-preview-stage">
            {binaryLoading ? (
              <span>Loading...</span>
            ) : binaryError ? (
              <span style={{ color: "var(--red)" }}>{binaryError}</span>
            ) : binaryPreviewUrl ? (
              <img
                src={binaryPreviewUrl}
                alt={filename}
                className="an-file-preview-media"
              />
            ) : null}
          </div>
        ) : isPdf || isHtml ? (
          binaryLoading ? (
            <div className="an-file-preview-state">Loading...</div>
          ) : binaryError ? (
            <div className="an-file-preview-state" style={{ color: "var(--red)" }}>
              {binaryError}
            </div>
          ) : binaryPreviewUrl ? (
            <iframe
              key={binaryPreviewUrl}
              src={binaryPreviewUrl}
              title={filename}
              sandbox={isHtml ? HTML_PREVIEW_SANDBOX : undefined}
              referrerPolicy={isHtml ? "no-referrer" : undefined}
              className={`an-file-preview-frame${isHtml ? " is-html" : ""}`}
            />
          ) : null
        ) : shouldUseKkFileView ? (
          kkLoading ? (
            <div className="an-file-preview-state">Loading...</div>
          ) : kkError ? (
            <div className="an-file-preview-state" style={{ color: "var(--red)" }}>
              {kkError}
            </div>
          ) : kkViewerUrl ? (
            <iframe
              key={kkViewerUrl}
              src={kkViewerUrl}
              title={filename}
              className="an-file-preview-frame is-kkfileview"
            />
          ) : null
        ) : shouldLoadText ? (
          textLoading ? (
            <div className="an-file-preview-state">Loading...</div>
          ) : textError ? (
            <div className="an-file-preview-state" style={{ color: "var(--red)" }}>
              {textError}
            </div>
          ) : textKind === "markdown" ? (
            <div className="an-file-preview-text is-markdown">
              <MessageMarkdown text={textContent ?? ""} />
            </div>
          ) : (
            <div className="an-file-preview-text is-plain">
              <pre className="an-file-preview-pre">{textContent ?? ""}</pre>
            </div>
          )
        ) : (
          <div className="an-file-preview-empty">
            <FileTypeIcon contentType={contentType} filename={filename} size={44} />
            <p>{kkError || "This file type cannot be previewed directly"}</p>
            <button
              type="button"
              onClick={handleDownload}
              className="an-btn an-btn-primary"
            >
              <AppIcon name="download" className="w-4 h-4" />
              Download file
            </button>
          </div>
        )}
      </div>
    </Root>
  );
}

export function FilePreviewSidebar(props: Omit<Parameters<typeof FilePreviewPanel>[0], "variant">) {
  return <FilePreviewPanel {...props} variant="side" />;
}
