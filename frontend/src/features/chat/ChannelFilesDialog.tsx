import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
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
        <div className="py-8 text-center text-xs text-zinc-500">Loading…</div>
      ) : files.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-600">
          No files in this channel yet. Upload with 📎 in the composer.
        </div>
      ) : (
        <FileGrid files={files} focusFileId={focusFileId} />
      )}
    </FloatingPanel>
  );
}
