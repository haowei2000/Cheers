import { useEffect, useState } from "react";
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

function swapFileAction(url: string, action: "preview" | "download" | "content") {
  const [base, query] = url.split("?");
  const next = base.replace(/\/(preview|download|content)$/, `/${action}`);
  return query ? `${next}?${query}` : next;
}

export function FilePreviewPanel({
  url,
  filename,
  contentType,
  sizeBytes,
  subtitle,
  onClose,
  variant = "side",
}: {
  url: string;
  filename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  subtitle?: string | null;
  onClose: () => void;
  variant?: "side" | "main";
}) {
  const previewUrl = swapFileAction(url, "preview");
  const downloadUrl = swapFileAction(url, "download");
  const contentUrl = swapFileAction(url, "content");
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
  const isPlainText = normalizedType.startsWith("text/") || ext === "txt";
  const isExtractedPreview =
    ["docx", "xlsx"].includes(ext) ||
    normalizedType.includes("wordprocessingml") ||
    normalizedType.includes("spreadsheetml");
  const shouldLoadText = !isImage && !isPdf && !isHtml && (isMarkdown || isPlainText || isExtractedPreview);
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
            throw new Error(data.error || "当前文件暂不支持预览");
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
    openProtectedFile(previewUrl).catch((e) => {
      setBinaryError(e instanceof Error ? e.message : String(e));
    });
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
          <Tooltip content="下载文件" placement="bottom">
            <button
              type="button"
              onClick={handleDownload}
              className="an-file-preview-action"
              aria-label="下载文件"
            >
              <AppIcon name="download" />
            </button>
          </Tooltip>
          <Tooltip content="在新标签页打开" placement="bottom">
            <button
              type="button"
              onClick={handleOpen}
              className="an-file-preview-action"
              aria-label="在新标签页打开"
            >
              <AppIcon name="externalLink" />
            </button>
          </Tooltip>
          <Tooltip content="关闭预览" placement="bottom">
            <button
              type="button"
              onClick={onClose}
              className="an-file-preview-action"
              aria-label="关闭预览"
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
              <span>加载中...</span>
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
            <div className="an-file-preview-state">加载中...</div>
          ) : binaryError ? (
            <div className="an-file-preview-state" style={{ color: "var(--red)" }}>
              {binaryError}
            </div>
          ) : binaryPreviewUrl ? (
            <iframe
              key={binaryPreviewUrl}
              src={binaryPreviewUrl}
              title={filename}
              sandbox={isHtml ? "" : undefined}
              referrerPolicy={isHtml ? "no-referrer" : undefined}
              className="an-file-preview-frame"
            />
          ) : null
        ) : shouldLoadText ? (
          textLoading ? (
            <div className="an-file-preview-state">加载中…</div>
          ) : textError ? (
            <div className="an-file-preview-state" style={{ color: "var(--red)" }}>
              {textError}
            </div>
          ) : textKind === "markdown" ? (
            <div className="an-file-preview-text">
              <MessageMarkdown text={textContent ?? ""} />
            </div>
          ) : (
            <div className="an-file-preview-text">
              <pre className="an-file-preview-pre">{textContent ?? ""}</pre>
            </div>
          )
        ) : (
          <div className="an-file-preview-empty">
            <FileTypeIcon contentType={contentType} filename={filename} size={44} />
            <p>当前文件类型无法直接预览</p>
            <button
              type="button"
              onClick={handleDownload}
              className="an-btn an-btn-primary"
            >
              <AppIcon name="download" className="w-4 h-4" />
              下载文件
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
