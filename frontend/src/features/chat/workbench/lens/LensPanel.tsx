import { useEffect, useRef } from "react";
import { Save } from "lucide-react";
import type { FsClient } from "../fsClient";
import type { ViewDef } from "../manifest";
import { useFile } from "../jsonFile";
import { getLens } from "./registry";

// Host for one built-in lens over one file: load (parsed by format) -> lens -> save on
// demand. Path/pin/mode chrome lives in the file browser's header — this adds only what
// the lens itself needs: a Save for lenses that edit (viewOnly lenses get none, so a
// stale snapshot can't be written back over a concurrent agent write).
export function LensPanel({ fs, view, reloadTick }: { fs: FsClient; view: ViewDef; reloadTick?: number }) {
  const lens = getLens(view.lens);
  const fallback: unknown = view.file.endsWith(".json") ? null : "";
  const { data, setData, save, status, reload } = useFile<unknown>(fs, view.file, fallback);

  // Live-push: the Desk changed on the server (a bot finished writing) — re-pull a
  // CLEAN preview so the default view of machine-written files (metrics, boards) stays
  // live. In-progress lens edits are never clobbered: dirty = any onChange since the
  // last load/save, and a dirty buffer skips the reload.
  const dirty = useRef(false);
  const seenTick = useRef(reloadTick);
  useEffect(() => {
    if (reloadTick === undefined || reloadTick === seenTick.current) return;
    seenTick.current = reloadTick;
    if (!dirty.current) void reload();
  }, [reloadTick, reload]);
  const onChange = (next: unknown) => {
    dirty.current = true;
    setData(next);
  };
  const onSave = async () => {
    await save(data);
    dirty.current = false;
  };

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="flex-1 min-h-0 overflow-hidden">
        {lens ? (
          lens.render({ data, config: view.config, onChange })
        ) : (
          <div className="p-3 text-amber-500">Unknown lens: {view.lens}</div>
        )}
      </div>
      {(status || !lens?.viewOnly) && (
        <div className="flex items-center gap-2 px-3 py-1 border-t border-zinc-800 flex-shrink-0">
          <span className="text-[11px] text-zinc-500 truncate flex-1">{status}</span>
          {!lens?.viewOnly && (
            <button onClick={() => void onSave()} className="flex items-center gap-1 text-zinc-400 hover:text-zinc-100">
              <Save className="w-3.5 h-3.5" /> Save
            </button>
          )}
        </div>
      )}
    </div>
  );
}
