import { IconButton } from "@/components/ui/icon-button";
import { Tip } from "@/components/ui/tip";
import { FloatingPanelActionPortal } from "@/components/ui/floating-panel";
import { pointRect, useContextActions } from "@/components/ui/context-actions";
import { rangedFileContextItem, useContextPickStore } from "@/features/chat/context/contextPick";
import { Paperclip, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { FsClient } from "../fsClient";
import type { ViewDef } from "../manifest";
import { isStructuredPath, useFile } from "../jsonFile";
import { getLens } from "./registry";
import { sourcePathLineRange, uniqueSourceTextRange } from "../contextSource";

// Host for one built-in lens over one file: load (parsed by format) -> lens -> save on
// demand. Path/pin/mode chrome lives in the file browser's header — this adds only what
// the lens itself needs: a Save for lenses that edit (viewOnly lenses get none, so a
// stale snapshot can't be written back over a concurrent agent write).
export function LensPanel({ fs, view, channelId, reloadTick }: { fs: FsClient; view: ViewDef; channelId: string; reloadTick?: number }) {
  const lens = getLens(view.lens);
  const fallback: unknown = isStructuredPath(view.file) ? null : "";
  const { data, setData, save, status, raw, reload } = useFile<unknown>(fs, view.file, fallback);
  const { open } = useContextActions();
  const addContext = useContextPickStore((state) => state.add);

  // Live-push: the Desk changed on the server (a bot finished writing) — re-pull a
  // CLEAN preview so the default view of machine-written files (metrics, boards) stays
  // live. In-progress lens edits are never clobbered: dirty = any onChange since the
  // last load/save, and a dirty buffer skips the reload.
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const seenTick = useRef(reloadTick);
  useEffect(() => {
    if (reloadTick === undefined || reloadTick === seenTick.current) return;
    seenTick.current = reloadTick;
    if (!dirtyRef.current) void reload();
  }, [reloadTick, reload]);
  const onChange = (next: unknown) => {
    dirtyRef.current = true;
    setDirty(true);
    setData(next);
  };
  const onSave = useCallback(async () => {
    await save(data);
    dirtyRef.current = false;
    setDirty(false);
  }, [data, save]);
  // The Save control belongs in the window's action island, next to minimize
  // and close. Keeping it out of the body prevents a second bottom toolbar
  // from competing with the active lens itself.
  const saveAction = useMemo(() => ({
    id: `save-lens-${view.file}`,
    label: `Save ${view.file}`,
    priority: "primary" as const,
    trigger: { visibility: "persistent" as const },
    icon: Save,
    onSelect: () => void onSave(),
    control: (
      <Tip content={`Save ${view.file}`}>
        <IconButton
          label={`Save ${view.file}`}
          controlSize="compact"
          onClick={() => void onSave()}
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
        </IconButton>
      </Tip>
    ),
  }), [onSave, view.file]);
  const requestContextPick = (event: React.MouseEvent<Element>, target: { label: string; sourcePath?: ReadonlyArray<string | number>; sourceText?: string }) => {
    const range = target.sourceText !== undefined
      ? uniqueSourceTextRange(raw, target.sourceText)
      : target.sourcePath
        ? sourcePathLineRange(raw, target.sourcePath)
        : null;
    event.preventDefault();
    event.stopPropagation();
    open({
      anchor: pointRect(event.clientX, event.clientY),
      source: "pointer",
      restoreFocus: event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
      actions: [{
        id: "add-context",
        label: range ? `Add ${target.label} to context` : "Source row unavailable",
        icon: <Paperclip className="h-4 w-4" />,
        disabled: !range,
        run: () => {
          if (!range) return;
          const item = rangedFileContextItem(view.file, range.start, range.end);
          addContext(channelId, { ...item, label: target.label });
          toast.success(`Added ${target.label} (lines ${range.start}-${range.end}) to context`);
        },
      }],
    });
  };

  return (
    <div className="flex flex-col h-full text-compact">
      {!lens?.viewOnly && <FloatingPanelActionPortal action={saveAction} active={dirty} />}
      <div className="flex-1 min-h-0 overflow-hidden">
        {lens ? (
          lens.render({ data, config: view.config, onChange, requestContextPick })
        ) : (
          <div className="p-3 text-warning-400">Unknown lens: {view.lens}</div>
        )}
      </div>
      {status && <div className="mx-3 mb-2 flex-shrink-0 truncate text-compact text-content-muted">{status}</div>}
    </div>
  );
}
