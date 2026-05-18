import {
  lazy,
  memo,
  Suspense,
  useCallback,
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
const MESSAGE_COLLAPSE_MAX_HEIGHT = 360;
const MESSAGE_COLLAPSE_THRESHOLD = 40;
const PROTECTED_IMAGE_PREVIEW_CACHE_LIMIT = 100;
const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>/gi;
const OPEN_THINK_TAG = "<think>";
const RICH_MARKDOWN_RE =
  /(```|`[^`]+`|\*\*|__|~~|!\[[^\]]*]\(|\[[^\]]+]\(|<think>|<\/think>|^\s{0,3}#{1,6}\s|^\s{0,3}>|^\s{0,3}[-*+]\s|^\s{0,3}\d+\.\s|^\s*\|.*\|)/m;
const protectedImagePreviewCache = new Map<string, string>();
const protectedImagePreviewInFlight = new Map<string, Promise<string>>();
const ThinkMarkdownContent = lazy(() =>
  import("./ThinkMarkdownContent").then((module) => ({
    default: module.ThinkMarkdownContent,
  })),
);

function pruneProtectedImagePreviewCache(): void {
  while (protectedImagePreviewCache.size > PROTECTED_IMAGE_PREVIEW_CACHE_LIMIT) {
    const oldest = protectedImagePreviewCache.keys().next().value;
    if (!oldest) return;
    const objectUrl = protectedImagePreviewCache.get(oldest);
    protectedImagePreviewCache.delete(oldest);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function loadProtectedImagePreview(previewUrl: string): Promise<string> {
  const cached = protectedImagePreviewCache.get(previewUrl);
  if (cached) return Promise.resolve(cached);
  const inFlight = protectedImagePreviewInFlight.get(previewUrl);
  if (inFlight) return inFlight;

  const request = createProtectedFileObjectUrl(previewUrl)
    .then((objectUrl) => {
      protectedImagePreviewCache.set(previewUrl, objectUrl);
      pruneProtectedImagePreviewCache();
      return objectUrl;
    })
    .finally(() => {
      protectedImagePreviewInFlight.delete(previewUrl);
    });
  protectedImagePreviewInFlight.set(previewUrl, request);
  return request;
}

function StreamingThinkFold({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded border border-gray-200 bg-gray-50 overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full px-2 py-1 text-left text-gray-400 hover:bg-gray-100 flex items-center gap-1"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          ▶
        </span>
        <span>{"<think> "}{open ? "Collapse" : "Expand"}</span>
      </button>
      {open && (
        <pre className="p-2 text-xs text-gray-500 whitespace-pre-wrap border-t border-gray-100 max-h-48 overflow-auto">
          {content}
        </pre>
      )}
    </div>
  );
}

function StreamingPlainContent({
  content,
  keyPrefix = "",
}: {
  content: string;
  keyPrefix?: string;
}) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  THINK_BLOCK_RE.lastIndex = 0;

  const pushText = (text: string) => {
    if (!text) return;
    parts.push(
      <span key={`${keyPrefix}stream-${key++}`} className="whitespace-pre-wrap break-words">
        {text}
      </span>,
    );
  };

  while ((match = THINK_BLOCK_RE.exec(content)) !== null) {
    pushText(content.slice(lastIndex, match.index));
    parts.push(
      <StreamingThinkFold
        key={`${keyPrefix}stream-think-${key++}`}
        content={match[1]?.trim() || ""}
      />,
    );
    lastIndex = THINK_BLOCK_RE.lastIndex;
  }

  const tail = content.slice(lastIndex);
  const lowerTail = tail.toLowerCase();
  const openThinkIndex = lowerTail.lastIndexOf(OPEN_THINK_TAG);
  if (openThinkIndex >= 0 && lowerTail.indexOf("</think>", openThinkIndex) < 0) {
    pushText(tail.slice(0, openThinkIndex));
    parts.push(
      <StreamingThinkFold
        key={`${keyPrefix}stream-think-open-${key++}`}
        content={tail.slice(openThinkIndex + OPEN_THINK_TAG.length).trim()}
      />,
    );
  } else {
    pushText(tail);
  }

  return <>{parts}</>;
}

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
  if (contentType.includes("spreadsheetml") || ["xls", "xlsx", "csv"].includes(ext)) return "Spreadsheet";
  if (contentType.includes("text/") || ["md", "txt"].includes(ext)) return "Text";
  if (isImageFile(file)) return "Image";
  return "Files";
}

function fileName(file: FileInfo): string {
  return file.original_filename || file.file_id;
}

function isImageFile(file: FileInfo): boolean {
  const contentType = file.content_type ?? "";
  const ext = (file.original_filename?.split(".").pop() ?? "").toLowerCase();
  return contentType.startsWith("image/") || IMAGE_TYPES.has(ext);
}

function shouldUseRichMarkdown(content: string): boolean {
  if (!content) return false;
  return RICH_MARKDOWN_RE.test(content);
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
    setImageFailed(false);
    setImagePreviewSrc(null);
    loadProtectedImagePreview(previewUrl)
      .then((url) => {
        if (!cancelled) setImagePreviewSrc(url);
      })
      .catch(() => setImageFailed(true));
    return () => {
      cancelled = true;
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
          title={`Preview ${name}`}
        >
          {imageFailed ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-gray-400">
              <AppIcon name="image" className="h-5 w-5 text-gray-300" />
              <span>Preview unavailable</span>
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
              <span>Loading...</span>
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
            title="Preview"
            aria-label={`Preview ${name}`}
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
              title="Forward file"
              aria-label={`Forward ${name}`}
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
            title="Download"
            aria-label={`Download ${name}`}
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

export interface MessageContentClampProps {
  children: ReactNode;
  contentKey: string;
  disabled?: boolean;
  maxHeight?: number;
}

export function MessageContentClamp({
  children,
  contentKey,
  disabled = false,
  maxHeight = MESSAGE_COLLAPSE_MAX_HEIGHT,
}: MessageContentClampProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [contentKey]);

  useEffect(() => {
    if (disabled) {
      setCanCollapse(false);
      return;
    }
    const element = contentRef.current;
    if (!element) return;
    const update = () => {
      const nextCanCollapse =
        element.scrollHeight > maxHeight + MESSAGE_COLLAPSE_THRESHOLD;
      setCanCollapse(nextCanCollapse);
      if (!nextCanCollapse) setExpanded(false);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [contentKey, disabled, maxHeight]);

  if (disabled) return <>{children}</>;

  const collapsed = canCollapse && !expanded;
  return (
    <div
      className={`an-message-clamp ${
        collapsed ? "is-collapsed" : expanded ? "is-expanded" : ""
      }`}
    >
      <div
        className="an-message-clamp-window"
        style={collapsed ? { maxHeight } : undefined}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {canCollapse && (
        <button
          type="button"
          className="an-message-clamp-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <AppIcon
            name={expanded ? "chevronUp" : "chevronDown"}
            className="h-3.5 w-3.5"
          />
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
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
  collapseKey?: string;
  collapseMaxHeight?: number;
  disableAutoCollapse?: boolean;
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
  collapseKey,
  collapseMaxHeight,
  disableAutoCollapse = false,
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
  const richMarkdown = hasContent ? shouldUseRichMarkdown(content) : false;
  const [richReady, setRichReady] = useState(!richMarkdown);

  useEffect(() => {
    if (!richMarkdown || streaming) {
      setRichReady(!richMarkdown);
      return;
    }
    setRichReady(false);
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => setRichReady(true), {
        timeout: 500,
      });
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(() => setRichReady(true), 80);
    return () => window.clearTimeout(timer);
  }, [content, richMarkdown, streaming]);

  const hideSelectionButton = useCallback(() => {
    setSelectionCopy(null);
  }, []);

  const updateSelection = useCallback(() => {
    if (!hasContent) {
      setSelectionCopy(null);
      return;
    }
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
  }, [hasContent]);

  useEffect(() => {
    if (!selectionCopy) return;
    const handlePointerDown = (event: PointerEvent) => {
      const container = bodySelectionRef.current;
      if (!container || container.contains(event.target as Node)) return;
      hideSelectionButton();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideSelectionButton();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("scroll", hideSelectionButton, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", hideSelectionButton);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("scroll", hideSelectionButton, true);
      window.removeEventListener("resize", hideSelectionButton);
    };
  }, [hideSelectionButton, selectionCopy]);

  const copySelectionText = async () => {
    if (!selectionCopy?.text) return;
    try {
      await navigator.clipboard.writeText(selectionCopy.text);
      toast.success("Copied selected content");
      window.getSelection()?.removeAllRanges();
      setSelectionCopy(null);
    } catch {
      toast.error("Copy failed");
    }
  };

  const markdownFallback = (
    <span className="whitespace-pre-wrap break-words">{content}</span>
  );
  const bodyChildren = (
    <>
      {streaming && !hasContent ? (
        <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-gray-400 align-middle" />
      ) : hasContent && streaming ? (
        <StreamingPlainContent content={content} keyPrefix={keyPrefix} />
      ) : hasContent && (!richMarkdown || !richReady) ? (
        markdownFallback
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
        <div
          ref={bodySelectionRef}
          className="relative"
          onKeyUp={updateSelection}
          onMouseUp={updateSelection}
          onTouchEnd={updateSelection}
        >
          <MessageContentClamp
            contentKey={collapseKey ?? content}
            disabled={disableAutoCollapse || !hasContent || !!streaming}
            maxHeight={collapseMaxHeight}
          >
            {renderBody ? renderBody(body) : body}
          </MessageContentClamp>
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
              title="Copy selected content"
              aria-label="Copy selected content"
            >
              <AppIcon name="copy" className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : null}
    </>
  );
});
