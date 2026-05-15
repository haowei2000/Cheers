import { useState, type CSSProperties, type ReactNode } from "react";
import { renderWithThinkFolding } from "../lib/think";
import type { FileInfo } from "../types";
import { AppIcon, FileTypeIcon } from "./icons";

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);

function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeLabel(file: FileInfo): string {
  const contentType = file.content_type ?? "";
  const ext = (file.original_filename?.split(".").pop() ?? "").toLowerCase();
  if (contentType.includes("pdf") || ext === "pdf") return "PDF";
  if (contentType.includes("wordprocessingml") || ["doc", "docx"].includes(ext)) return "Word";
  if (contentType.includes("spreadsheetml") || ["xls", "xlsx", "csv"].includes(ext)) return "表格";
  if (contentType.includes("text/") || ["md", "txt"].includes(ext)) return "文本";
  if (isImageFile(file)) return "图片";
  return "文件";
}

function fileName(file: FileInfo): string {
  return file.original_filename || file.file_id;
}

function isImageFile(file: FileInfo): boolean {
  const contentType = file.content_type ?? "";
  const ext = (file.original_filename?.split(".").pop() ?? "").toLowerCase();
  return contentType.startsWith("image/") || IMAGE_TYPES.has(ext);
}

interface ChatAttachmentCardProps {
  align?: "left" | "right";
  file: FileInfo;
  getDownloadUrl: (file: FileInfo) => string;
  getPreviewUrl: (file: FileInfo) => string;
  onPreview?: (file: FileInfo) => void;
}

function ChatAttachmentCard({
  align = "left",
  file,
  getDownloadUrl,
  getPreviewUrl,
  onPreview,
}: ChatAttachmentCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const name = fileName(file);
  const size = formatFileSize(file.size_bytes);
  const type = fileTypeLabel(file);
  const previewUrl = getPreviewUrl(file);
  const downloadUrl = getDownloadUrl(file);
  const image = isImageFile(file);

  const openPreview = () => {
    if (onPreview) onPreview(file);
    else window.open(previewUrl, "_blank", "noreferrer");
  };

  return (
    <div
      className={`group w-full max-w-[320px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm transition-colors hover:border-gray-300 ${
        align === "right" ? "self-end" : "self-start"
      }`}
    >
      {image ? (
        <button
          type="button"
          onClick={openPreview}
          className="block w-full bg-gray-50 text-left"
          title={`预览 ${name}`}
        >
          {imageFailed ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-gray-400">
              <AppIcon name="image" className="h-5 w-5 text-gray-300" />
              <span>预览不可用</span>
            </div>
          ) : (
            <img
              src={previewUrl}
              alt={name}
              className="block h-36 w-full object-cover"
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          )}
        </button>
      ) : null}

      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-50">
          <FileTypeIcon contentType={file.content_type} filename={name} size={28} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-gray-800">{name}</div>
          <div className="truncate text-[11px] text-gray-400">
            {type}
            {size ? ` · ${size}` : ""}
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={openPreview}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
            title="预览"
            aria-label={`预览 ${name}`}
          >
            <AppIcon name="preview" className="h-4 w-4" />
          </button>
          <a
            href={downloadUrl}
            download={name}
            onClick={(event) => event.stopPropagation()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
            title="下载"
            aria-label={`下载 ${name}`}
          >
            <AppIcon name="download" className="h-4 w-4" />
          </a>
        </div>
      </div>
    </div>
  );
}

export interface ChatAttachmentsProps {
  align?: "left" | "right";
  files?: FileInfo[];
  getDownloadUrl: (file: FileInfo) => string;
  getPreviewUrl: (file: FileInfo) => string;
  onPreview?: (file: FileInfo) => void;
}

export function ChatAttachments({
  align = "left",
  files,
  getDownloadUrl,
  getPreviewUrl,
  onPreview,
}: ChatAttachmentsProps) {
  if (!files?.length) return null;

  return (
    <div className={`mb-1.5 flex flex-col gap-1.5 ${align === "right" ? "items-end" : "items-start"}`}>
      {files.map((file) => (
        <ChatAttachmentCard
          key={file.file_id}
          align={align}
          file={file}
          getDownloadUrl={getDownloadUrl}
          getPreviewUrl={getPreviewUrl}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}

export interface ChatMessageRendererProps {
  align?: "left" | "right";
  attachments?: ReactNode;
  bodyClassName?: string;
  bodyStyle?: CSSProperties;
  bodySuffix?: ReactNode;
  content: string;
  files?: FileInfo[];
  getDownloadUrl?: (file: FileInfo) => string;
  getPreviewUrl?: (file: FileInfo) => string;
  keyPrefix?: string;
  onPreview?: (file: FileInfo) => void;
  renderBody?: (children: ReactNode) => ReactNode;
  showStreamingCursor?: boolean;
  streaming?: boolean;
  onFileClick?: (url: string, filename: string) => void;
  onImageClick?: (src: string) => void;
}

export function ChatMessageRenderer({
  align = "left",
  attachments,
  bodyClassName,
  bodyStyle,
  bodySuffix,
  content,
  files,
  getDownloadUrl,
  getPreviewUrl,
  keyPrefix,
  onFileClick,
  onImageClick,
  onPreview,
  renderBody,
  showStreamingCursor = true,
  streaming,
}: ChatMessageRendererProps) {
  const hasContent = content.trim().length > 0;
  const bodyChildren = (
    <>
      {streaming && !hasContent ? (
        <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-gray-400 align-middle" />
      ) : hasContent ? (
        renderWithThinkFolding(
          content,
          keyPrefix,
          streaming,
          onImageClick,
          onFileClick,
        )
      ) : null}
      {showStreamingCursor && streaming && hasContent && (
        <span
          className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm align-middle"
          style={{ background: "var(--fg-3)" }}
        />
      )}
      {bodySuffix}
    </>
  );
  const body =
    bodyClassName || bodyStyle ? (
      <div className={bodyClassName} style={bodyStyle}>
        {bodyChildren}
      </div>
    ) : (
      bodyChildren
    );

  return (
    <>
      {attachments ??
        (getDownloadUrl && getPreviewUrl ? (
          <ChatAttachments
            align={align}
            files={files}
            getDownloadUrl={getDownloadUrl}
            getPreviewUrl={getPreviewUrl}
            onPreview={onPreview}
          />
        ) : null)}
      {(hasContent || streaming || bodySuffix) ? (renderBody ? renderBody(body) : body) : null}
    </>
  );
}
