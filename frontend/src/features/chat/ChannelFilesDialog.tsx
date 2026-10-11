import { useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/error-state";
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
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setFiles(null);
    setError(false);
    listChannelFiles(channelId)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [channelId, attempt]);

  return (
    <FloatingPanel
      title="Channel files"
      icon={Paperclip}
      onClose={onClose}
      storageKey="cheers.float.files"
      // Same lane-window defaults as the other instrument panels (drag/resize to
      // taste; geometry persists). Bounded to the lane via LaneBoundsContext.
      // First open auto-fills / picks a free zone via spawnKind.
      className="w-[640px] h-[70%]"
      spawnKind="files"
      defaultPosClassName="top-2 left-2"
      bodyClassName="overflow-hidden p-0 space-y-0"
      emptyState={files?.length === 0 ? {
        icon: Paperclip,
        title: "No files in this channel yet",
        hint: "Upload with the paperclip in the composer.",
      } : undefined}
      collapsedSummary={(expand) => (
        <GlanceRow
          Icon={Paperclip}
          label="Files"
          value={error ? "Error" : files === null ? "…" : String(files.length)}
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
      {error ? (
        <ErrorState
          className="h-full"
          title="Couldn't load channel files"
          description="Check your connection and try again."
          action={{ label: "Retry", onClick: () => setAttempt((n) => n + 1) }}
        />
      ) : files === null ? (
        <SurfaceSpinner />
      ) : (
        <FileGrid
          files={files}
          focusFileId={focusFileId}
          channelId={channelId}
          className="h-full overflow-y-auto px-4 pb-4 pt-(--floating-panel-safe-top)"
        />
      )}
    </FloatingPanel>
  );
}
