import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { GlanceRow, DetailLine } from "@/components/ui/glance-row";
import { listChannelFiles } from "@/api/files";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type { FileInfo } from "@/types";
import { FileGrid } from "./fileView";

const GLANCE_FILE_LINES = 4;

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
      // Same lane-window defaults as the other instrument panels (drag/resize to
      // taste; geometry persists). Bounded to the lane via LaneBoundsContext.
      className="w-[640px] h-[70%]"
      defaultPosClassName="top-2 left-2"
      collapsedSummary={(expand) => (
        <GlanceRow
          Icon={Paperclip}
          label="Files"
          value={files === null ? "…" : String(files.length)}
          onClick={expand}
          title="Open channel files"
        >
          {files?.slice(0, GLANCE_FILE_LINES).map((f) => (
            <DetailLine key={f.file_id} name={f.original_filename ?? f.file_id} />
          ))}
          {files && files.length > GLANCE_FILE_LINES && (
            <DetailLine name={`+${files.length - GLANCE_FILE_LINES} more`} />
          )}
        </GlanceRow>
      )}
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
