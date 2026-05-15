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

type TextPreviewKind = "markdown" | "text";

function swapFileAction(url: string, action: "preview" | "download" | "content") {
  const [base, query] = url.split("?");
  const next = base.replace(/\/(preview|download|content)$/, `/${action}`);
  return query ? `${next}?${query}` : next;
}

export function FilePreviewSidebar({
  url,
  filename,
  contentType,
  sizeBytes,
  onClose,
}: {
  url: string;
  filename: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  onClose: () => void;
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
  const isMarkdown =
    normalizedType === "text/markdown" || ext === "md" || ext === "markdown";
  const isPlainText = normalizedType.startsWith("text/") || ext === "txt";
  const isExtractedPreview =
    ["docx", "xlsx"].includes(ext) ||
    normalizedType.includes("wordprocessingml") ||
    normalizedType.includes("spreadsheetml");
  const shouldLoadText = !isImage && !isPdf && (isMarkdown || isPlainText || isExtractedPreview);
  const sizeLabel =
    sizeBytes && sizeBytes > 0
      ? sizeBytes < 1024
        ? `${sizeBytes} B`
        : sizeBytes < 1024 * 1024
          ? `${(sizeBytes / 1024).toFixed(1)} KB`
          : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : "";

  const [textContent, setTextContent] = useState<string | null>(null);
  const [textKind, setTextKind] = useState<TextPreviewKind>(
    isMarkdown || ext === "xlsx" ? "markdown" : "text",
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
    if (!isImage && !isPdf) {
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
  }, [isImage, isPdf, previewUrl]);

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

  return (
    <aside className="w-full border-l border-gray-200 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-100 flex-shrink-0">
        <div className="w-7 h-7 rounded-md bg-blue-50 flex items-center justify-center flex-shrink-0">
          <FileTypeIcon contentType={contentType} filename={filename} size={18} />
        </div>
        <span className="text-sm font-semibold text-gray-900 truncate flex-1 min-w-0">
          {filename}
        </span>
        {sizeLabel && (
          <span className="hidden sm:inline text-[11px] text-gray-400">
            {sizeLabel}
          </span>
        )}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={handleDownload}
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="下载文件"
          >
            <AppIcon name="download" className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleOpen}
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            title="在新标签页打开"
          >
            <AppIcon name="externalLink" className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-base leading-none transition-colors"
            title="关闭"
          >
            <AppIcon name="close" className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isImage ? (
          <div className="min-h-full flex items-center justify-center bg-gray-50 p-4">
            {binaryLoading ? (
              <span className="text-sm text-gray-400">加载中...</span>
            ) : binaryError ? (
              <span className="text-sm text-red-400">{binaryError}</span>
            ) : binaryPreviewUrl ? (
              <img
                src={binaryPreviewUrl}
                alt={filename}
                className="max-w-full max-h-full object-contain rounded-md shadow-sm"
              />
            ) : null}
          </div>
        ) : isPdf ? (
          binaryLoading ? (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">
              加载中...
            </div>
          ) : binaryError ? (
            <div className="flex items-center justify-center h-full text-sm text-red-400">
              {binaryError}
            </div>
          ) : binaryPreviewUrl ? (
            <iframe
              key={binaryPreviewUrl}
              src={binaryPreviewUrl}
              title={filename}
              className="w-full h-full border-0"
            />
          ) : null
        ) : shouldLoadText ? (
          textLoading ? (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">
              加载中…
            </div>
          ) : textError ? (
            <div className="flex items-center justify-center h-full text-sm text-red-400">
              {textError}
            </div>
          ) : textKind === "markdown" ? (
            <div className="px-5 py-4">
              <MessageMarkdown text={textContent ?? ""} />
            </div>
          ) : (
            <div className="px-5 py-4">
              <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800 font-mono">
                {textContent ?? ""}
              </pre>
            </div>
          )
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-gray-500">
            <FileTypeIcon contentType={contentType} filename={filename} size={40} />
            <p>当前文件类型无法直接预览</p>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-3 py-2 text-xs font-medium text-white hover:bg-gray-700 transition-colors"
            >
              <AppIcon name="download" className="w-4 h-4" />
              下载文件
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
