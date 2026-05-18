import { lazy, Suspense, type MouseEvent } from "react";
import type { ContextData, FileInfo } from "../../types";
import type { MemoryTab } from "../ChannelHeader";
import type { FilePreviewPanelState } from "../../features/chat/hooks/useFilePreviewController";

const MemoryPanel = lazy(() =>
  import("../MemoryPanel").then((module) => ({ default: module.MemoryPanel })),
);
const FilePreviewSidebar = lazy(() =>
  import("../FilePreviewSidebar").then((module) => ({
    default: module.FilePreviewSidebar,
  })),
);

type ChannelFilePreview = {
  file_id: string;
  original_filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  channel_id?: string | null;
  channel_label?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
};

interface ChatSidePanelsProps {
  channelName: string;
  contextData: ContextData;
  currentUserId: string;
  filePreviewPanel: FilePreviewPanelState | null;
  filePreviewWidth: number;
  isMobile: boolean;
  memoryPanelOpen: boolean;
  memoryTab: MemoryTab | null;
  memoryWidth: number;
  onCloseFilePreview: () => void;
  onCloseMemory: () => void;
  onFileDeleted?: () => void;
  onFilePreview: (file: FileInfo) => void;
  onFilePreviewResize: (event: MouseEvent) => void;
  onMemoryResize: (event: MouseEvent) => void;
  onMemoryTabChange: (tab: MemoryTab) => void;
  selectedId: string | null;
}

function SidePanelFallback() {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-[var(--fg-3)]">
      Loading...
    </div>
  );
}

export function ChatSidePanels({
  channelName,
  contextData,
  currentUserId,
  filePreviewPanel,
  filePreviewWidth,
  isMobile,
  memoryPanelOpen,
  memoryTab,
  memoryWidth,
  onCloseFilePreview,
  onCloseMemory,
  onFileDeleted,
  onFilePreview,
  onFilePreviewResize,
  onMemoryResize,
  onMemoryTabChange,
  selectedId,
}: ChatSidePanelsProps) {
  return (
    <>
      {memoryPanelOpen && selectedId && (
        <div
          className={
            isMobile
              ? "fixed inset-0 z-[70] flex bg-white"
              : "relative flex-shrink-0 flex"
          }
          style={{ width: isMobile ? "100%" : memoryWidth }}
        >
          {!isMobile && (
            <div
              onMouseDown={onMemoryResize}
              className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-gray-300 transition-colors z-10"
            />
          )}
          <Suspense fallback={<SidePanelFallback />}>
            <MemoryPanel
              channelId={selectedId}
              channelName={channelName}
              contextData={contextData}
              activeLayer={memoryTab ?? undefined}
              onLayerChange={(layer) => onMemoryTabChange(layer as MemoryTab)}
              currentUserId={currentUserId}
              onFilePreview={(file: ChannelFilePreview) =>
                onFilePreview({
                  file_id: file.file_id,
                  original_filename: file.original_filename ?? undefined,
                  content_type: file.content_type ?? undefined,
                  size_bytes: file.size_bytes ?? undefined,
                  channel_id: file.channel_id ?? selectedId,
                  channel_label: file.channel_label ?? channelName,
                  scope_type: file.scope_type ?? "channel",
                  scope_id: file.scope_id ?? selectedId,
                })
              }
              onClose={onCloseMemory}
            />
          </Suspense>
        </div>
      )}
      {filePreviewPanel && (
        <div
          className={
            isMobile
              ? "fixed inset-0 z-[70] flex bg-white"
              : "relative flex-shrink-0 flex"
          }
          style={{ width: isMobile ? "100%" : filePreviewWidth }}
        >
          {!isMobile && (
            <div
              onMouseDown={onFilePreviewResize}
              className="absolute top-0 left-0 h-full w-1 cursor-col-resize hover:bg-gray-300 transition-colors z-10"
            />
          )}
          <Suspense fallback={<SidePanelFallback />}>
            <FilePreviewSidebar
              url={filePreviewPanel.url}
              filename={filePreviewPanel.filename}
              contentType={filePreviewPanel.contentType}
              sizeBytes={filePreviewPanel.sizeBytes}
              fileId={filePreviewPanel.fileId}
              channelId={filePreviewPanel.channelId}
              scopeType={filePreviewPanel.scopeType}
              scopeId={filePreviewPanel.scopeId}
              source={filePreviewPanel.source}
              onDeleted={onFileDeleted}
              onClose={onCloseFilePreview}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
