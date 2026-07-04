import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { listChannelFiles } from "@/api/files";
import type { FileInfo } from "@/types";
import { Dialog } from "@/components/ui/dialog";
import { FileTypeIcon } from "./fileIcon";
import { formatBytes } from "./fileUtils";

/**
 * Pick already-uploaded channel files to attach to the composer — the counterpart to
 * "upload from computer". Lists the channel's file library (listChannelFiles), multi-select,
 * and returns the chosen FileInfo[]. Files already attached to the draft are shown checked +
 * disabled so they can't be added twice.
 */
export function ExistingFilePicker({
  channelId,
  attachedIds,
  onPick,
  onClose,
}: {
  channelId: string;
  attachedIds: string[];
  onPick: (files: FileInfo[]) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const already = new Set(attachedIds);

  useEffect(() => {
    let alive = true;
    listChannelFiles(channelId)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [channelId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirm() {
    const picked = (files ?? []).filter((f) => selected.has(f.file_id));
    if (picked.length) onPick(picked);
    onClose();
  }

  return (
    <Dialog title="Pick channel files" onClose={onClose} maxWidth="max-w-xl">
      {files === null ? (
        <div className="py-8 flex items-center justify-center gap-2 text-xs text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : files.length === 0 ? (
        <div className="py-8 text-center text-xs text-zinc-600">
          No files in this channel yet. Upload one with 📎 first.
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-auto -mx-1">
          {files.map((f) => {
            const isAttached = already.has(f.file_id);
            const isSel = selected.has(f.file_id);
            const checked = isAttached || isSel;
            return (
              <button
                key={f.file_id}
                type="button"
                disabled={isAttached}
                onClick={() => toggle(f.file_id)}
                className={
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors " +
                  (isAttached
                    ? "opacity-50 cursor-not-allowed"
                    : isSel
                      ? "bg-indigo-600/15"
                      : "hover:bg-zinc-800/60")
                }
              >
                <span
                  className={
                    "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border " +
                    (checked ? "border-indigo-500 bg-indigo-600 text-white" : "border-zinc-600")
                  }
                >
                  {checked && <Check className="w-3 h-3" />}
                </span>
                <FileTypeIcon file={f} size={16} className="flex-shrink-0" />
                <span
                  className="min-w-0 flex-1 truncate text-sm text-zinc-200"
                  title={f.original_filename || f.file_id}
                >
                  {f.original_filename || f.file_id.slice(0, 8)}
                </span>
                {typeof f.size_bytes === "number" && (
                  <span className="text-xs text-zinc-500">{formatBytes(f.size_bytes)}</span>
                )}
                {isAttached && <span className="text-[10px] text-zinc-500">Added</span>}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={selected.size === 0}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Add{selected.size > 0 ? ` (${selected.size})` : ""}
        </button>
      </div>
    </Dialog>
  );
}
