import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { listChannelFiles } from "@/api/files";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type { FileInfo } from "@/types";
import { FileGrid } from "./fileView";

// The channel's CHAT file library — a dedicated view, kept separate from the workbench
// File panel (context_files). Images preview inline; other files download.
// A non-modal floating window (draggable, no backdrop) so browsing files never
// blocks the composer.
export function ChannelFilesDialog({
  channelId,
  onClose,
  focusFileId,
}: {
  channelId: string;
  onClose: () => void;
  focusFileId?: string;
}) {
  const [files, setFiles] = useState<FileInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    listChannelFiles(channelId)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [channelId]);

  return (
    <FloatingPanel
      title="Channel files"
      icon={Paperclip}
      onClose={onClose}
      storageKey="cheers.float.files"
      className="w-[640px]"
      // Default spawn at the top-LEFT of the chat area, clear of the right-anchored
      // ViewBoard/Workbench defaults (drag to taste; the position persists).
      defaultPosClassName="top-16 left-[max(1.5rem,20%)]"
    >
      {files === null ? (
        <SurfaceSpinner />
      ) : files.length === 0 ? (
        <EmptyState
          icon={Paperclip}
          title="No files in this channel yet"
          hint="Upload with the paperclip in the composer."
        />
      ) : (
        <FileGrid files={files} focusFileId={focusFileId} />
      )}
    </FloatingPanel>
  );
}
