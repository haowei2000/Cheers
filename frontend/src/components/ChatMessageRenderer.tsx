import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import toast from "react-hot-toast";
import type { FileInfo } from "../types";
import { createProtectedFileObjectUrl, downloadProtectedFile, openProtectedFile } from "../lib/protected-file";
import { AppIcon } from "./icons/AppIcon";
import { FileTypeIcon } from "./icons/FileTypeIcon";

const IMAGE_TYPES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);
const ThinkMarkdownContent = lazy(() =>
  import("./ThinkMarkdownContent").then((module) => ({
    default: module.ThinkMarkdownContent,
  })),
);

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
  if (contentType.includes("html") || ["html", "htm"].includes(ext)) return "HTML";
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
  onForward?: (file: FileInfo) => void;
}

const ChatAttachmentCard = memo(function ChatAttachmentCard({
  align = "left",
  file,
  getDownloadUrl,
  getPreviewUrl,
  onPreview,
  onForward,
}: ChatAttachmentCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const [imagePreviewSrc, setImagePreviewSrc] = useState<string | null>(null);
  const name = fileName(file);
  const size = formatFileSize(file.size_bytes);
  const type = fileTypeLabel(file);
  const previewUrl = getPreviewUrl(file);
  const downloadUrl = getDownloadUrl(file);
  const image = isImageFile(file);

  useEffect(() => {
    if (!image) {
      setImagePreviewSrc(null);
      setImageFailed(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageFailed(false);
    setImagePreviewSrc(null);
    createProtectedFileObjectUrl(previewUrl)
      .then((url) => {
        objectUrl = url;
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setImagePreviewSrc(url);
      })
      .catch(() => setImageFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image, previewUrl]);

  const openPreview = () => {
    if (onPreview) onPreview(file);
    else openProtectedFile(previewUrl).catch(() => setImageFailed(true));
  };

  const handleDownload = () => {
    downloadProtectedFile(downloadUrl, name).catch(() => setImageFailed(true));
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
          ) : imagePreviewSrc ? (
            <img
              src={imagePreviewSrc}
              alt={name}
              className="block h-36 w-full object-cover"
              loading="lazy"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-gray-400">
              <AppIcon name="image" className="h-5 w-5 text-gray-300" />
              <span>加载中...</span>
            </div>
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
          {onForward && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onForward(file);
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
              title="转发文件"
              aria-label={`转发 ${name}`}
            >
              <AppIcon name="forward" className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              handleDownload();
            }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
            title="下载"
            aria-label={`下载 ${name}`}
          >
            <AppIcon name="download" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
});

export interface ChatAttachmentsProps {
  align?: "left" | "right";
  files?: FileInfo[];
  getDownloadUrl: (file: FileInfo) => string;
  getPreviewUrl: (file: FileInfo) => string;
  onPreview?: (file: FileInfo) => void;
  onForward?: (file: FileInfo) => void;
}

export const ChatAttachments = memo(function ChatAttachments({
  align = "left",
  files,
  getDownloadUrl,
  getPreviewUrl,
  onPreview,
  onForward,
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
          onForward={onForward}
        />
      ))}
    </div>
  );
});

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
  onForwardFile?: (file: FileInfo) => void;
  renderBody?: (children: ReactNode) => ReactNode;
  showStreamingCursor?: boolean;
  streaming?: boolean;
  onFileClick?: (url: string, filename: string) => void;
  onImageClick?: (src: string) => void;
}

export const ChatMessageRenderer = memo(function ChatMessageRenderer({
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
  onForwardFile,
  renderBody,
  showStreamingCursor = true,
  streaming,
}: ChatMessageRendererProps) {
  const bodySelectionRef = useRef<HTMLDivElement | null>(null);
  const [selectionCopy, setSelectionCopy] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);
  const hasContent = content.trim().length > 0;

  useEffect(() => {
    if (!hasContent) return;
    const updateSelection = () => {
      const container = bodySelectionRef.current;
      const selection = window.getSelection();
      if (
        !container ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0 ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      ) {
        setSelectionCopy(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        setSelectionCopy(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setSelectionCopy(null);
        return;
      }
      const hostRect = container.getBoundingClientRect();
      const left = Math.min(
        Math.max(rect.right - hostRect.left - 36, 4),
        Math.max(hostRect.width - 40, 4),
      );
      const top = Math.max(rect.top - hostRect.top - 32, 4);
      setSelectionCopy({ text, top, left });
    };
    const hideSelectionButton = () => setSelectionCopy(null);
    const handlePointerDown = (event: PointerEvent) => {
      const container = bodySelectionRef.current;
      if (!container || container.contains(event.target as Node)) return;
      hideSelectionButton();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideSelectionButton();
    };

    document.addEventListener("selectionchange", updateSelection);
    document.addEventListener("mouseup", updateSelection);
    document.addEventListener("keyup", updateSelection);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", hideSelectionButton, true);
    window.addEventListener("resize", hideSelectionButton);
    return () => {
      document.removeEventListener("selectionchange", updateSelection);
      document.removeEventListener("mouseup", updateSelection);
      document.removeEventListener("keyup", updateSelection);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", hideSelectionButton, true);
      window.removeEventListener("resize", hideSelectionButton);
    };
  }, [hasContent]);

  const copySelectionText = async () => {
    if (!selectionCopy?.text) return;
    try {
      await navigator.clipboard.writeText(selectionCopy.text);
      toast.success("已复制选中内容");
      window.getSelection()?.removeAllRanges();
      setSelectionCopy(null);
    } catch {
      toast.error("复制失败");
    }
  };

  const markdownFallback = (
    <span className="whitespace-pre-wrap break-words">{content}</span>
  );
  const bodyChildren = (
    <>
      {streaming && !hasContent ? (
        <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-gray-400 align-middle" />
      ) : hasContent ? (
        <Suspense fallback={markdownFallback}>
          <ThinkMarkdownContent
            content={content}
            keyPrefix={keyPrefix}
            streaming={streaming}
            onImageClick={onImageClick}
            onFileClick={onFileClick}
          />
        </Suspense>
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
            onForward={onForwardFile}
          />
        ) : null)}
      {hasContent || streaming || bodySuffix ? (
        <div ref={bodySelectionRef} className="relative">
          {renderBody ? renderBody(body) : body}
          {selectionCopy && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                void copySelectionText();
              }}
              className="absolute z-20 inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-600 shadow-lg transition-colors hover:bg-gray-50 hover:text-gray-900"
              style={{
                top: selectionCopy.top,
                left: selectionCopy.left,
              }}
              title="复制选中内容"
              aria-label="复制选中内容"
            >
              <AppIcon name="copy" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : null}
    </>
  );
});
