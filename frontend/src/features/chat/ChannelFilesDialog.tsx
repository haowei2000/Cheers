import { useEffect, useState } from "react";
import { listChannelFiles } from "@/api/files";
import { Dialog } from "@/components/ui/dialog";
import type { FileInfo } from "@/types";
import { FileGrid } from "./fileView";

// The channel's CHAT file library — a dedicated view, kept separate from the workbench
// File panel (context_files). Images preview inline; other files download.
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
    <Dialog title="频道文件" onClose={onClose} maxWidth="max-w-2xl">
      {files === null ? (
        <div className="py-8 text-center text-xs text-zinc-500">加载中…</div>
      ) : files.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-600">
          这个频道还没有文件。在输入框用 📎 上传。
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-auto">
          <FileGrid files={files} focusFileId={focusFileId} />
        </div>
      )}
    </Dialog>
  );
}
