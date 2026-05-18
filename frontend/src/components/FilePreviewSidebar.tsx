import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { MessageMarkdown } from "../MessageMarkdown";
import { apiFetch } from "../api/client";
import {
  createProtectedFileObjectUrl,
  downloadProtectedFile,
  openProtectedFile,
} from "../lib/protected-file";
import { AppIcon } from "./icons/AppIcon";
import { FileTypeIcon } from "./icons/FileTypeIcon";
import { Tooltip } from "./Tooltip";

type TextPreviewKind = "html" | "markdown" | "text";
const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-popups allow-downloads";
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
  const [kkViewerUrl, setKkViewerUrl] = useState<string | null>(null);
  const [kkLoading, setKkLoading] = useState(false);
  const [kkError, setKkError] = useState<string | null>(null);
  const [kkFallbackToText, setKkFallbackToText] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const shouldUseKkFileView = isKkFileViewDocument && !kkFallbackToText;
  const shouldLoadText =
    !shouldUseKkFileView &&
    !isImage &&
    !isPdf &&
    !isHtml &&
    (isMarkdown || isPlainText || isExtractedPreview);

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
      setKkViewerUrl(null);
      setKkError(null);
      setKkLoading(false);
      return;
    }
    if (kkFallbackToText) {
      setKkViewerUrl(null);
      setKkLoading(false);
      return;
    }

    const fileId = extractFileId(previewUrl);
    if (!fileId) {
      setKkError("Could not identify the file preview URL");
      setKkFallbackToText(true);
      return;
    }

    let cancelled = false;
    setKkLoading(true);
    setKkError(null);
    setKkViewerUrl(null);
    apiFetch(`/files/${encodeURIComponent(fileId)}/kkfileview`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((payload) => {
        const data = payload?.data ?? payload;
        if (!data?.enabled || !data?.viewer_url) {
          throw new Error(data?.reason || "Document preview service is unavailable");
        }
        if (cancelled) return;
        setKkViewerUrl(String(data.viewer_url));
        setKkLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setKkError(e instanceof Error ? e.message : String(e));
        setKkLoading(false);
        setKkFallbackToText(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isKkFileViewDocument, kkFallbackToText, previewUrl, shouldUseKkFileView]);

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
    if (kkViewerUrl) {
      window.open(kkViewerUrl, "_blank", "noreferrer");
      return;
    }
    openProtectedFile(previewUrl).catch((e) => {
      setBinaryError(e instanceof Error ? e.message : String(e));
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
