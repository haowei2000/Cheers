import { ActionButton } from "@/components/ui/action-button";
import { pointRect, useContextActions } from "@/components/ui/context-actions";
import { rangedFileContextItem, useContextPickStore } from "@/features/chat/context/contextPick";
import { Paperclip } from "lucide-react";
import { useEffect, useRef } from "react";
import toast from "react-hot-toast";
import type { FsClient } from "../fsClient";
import { canEditData, canPatch, useFileSession, type FileSession } from "../jsonFile";
import { getLens } from "./registry";
import { sourcePathLineRange, uniqueSourceTextRange } from "../contextSource";

// One built-in lens over one file SESSION. The session is owned by the host, because the
// host is what shows the file's other view: Raw and Preview must be the same buffer, the
// same version and the same dirty flag, or a mode switch silently shows two answers for
// one file. `LensPanel` below is the standalone case — a host with no second view.
export function LensView({
  session,
  lensId,
  config,
  channelId,
  standalone,
}: {
  session: FileSession;
  lensId: string;
  config?: unknown;
  channelId: string;
  /** This lens is the file's whole UI, so it renders the session's own chrome (Save,
   *  status). False when the host has a Raw view over the same session and its own
   *  header: one buffer must not grow two Save buttons or report "Saved" twice. */
  standalone?: boolean;
}) {
  const lens = getLens(lensId);
  const { open } = useContextActions();
  const addContext = useContextPickStore((state) => state.add);
  const { path, data, parsedText } = session;

  // The session refuses these anyway (canEditData / canPatch); withdrawing the
  // affordance is the other half — an edit control that always bounces is a promise the
  // host does not keep. See LensProps.readOnly.
  const writable = canEditData(session);
  const patchable = canPatch(session);
  const onOps = patchable ? (ops: Parameters<FileSession["applyOps"]>[0]) => void session.applyOps(ops) : undefined;

  const requestContextPick = (event: React.MouseEvent<Element>, target: { label: string; sourcePath?: ReadonlyArray<string | number>; sourceText?: string }) => {
    // Resolved against `parsedText`, not `text`: the lens is pointing into the document
    // its data came from, and lines from any other revision would anchor elsewhere.
    const range = target.sourceText !== undefined
      ? uniqueSourceTextRange(parsedText, target.sourceText)
      : target.sourcePath
        ? sourcePathLineRange(parsedText, target.sourcePath)
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
          const item = rangedFileContextItem(path, range.start, range.end);
          addContext(channelId, { ...item, label: target.label });
          toast.success(`Added ${target.label} (lines ${range.start}-${range.end}) to context`);
        },
      }],
    });
  };

  const saveable = standalone && !lens?.viewOnly && !lens?.savesItself;
  return (
    <div className="flex flex-col h-full text-compact">
      <div className="flex-1 min-h-0 overflow-hidden">
        {lens ? (
          lens.render({ data, config, onChange: session.setData, onOps, readOnly: !writable, requestContextPick })
        ) : (
          <div className="p-3 text-warning-400">Unknown lens: {lensId}</div>
        )}
      </div>
      {standalone && (session.status || saveable) && (
        <div className="mx-2 mb-2 flex flex-shrink-0 items-center gap-2 rounded-sm bg-zinc-900/50 px-3 py-2">
          <span className="text-compact text-content-muted truncate flex-1">{session.status}</span>
          {saveable && (
            <ActionButton
              action="save"
              context="form"
              accessibleLabel={`Save ${path}`}
              controlSize="regular"
              disabled={!session.dirty}
              onClick={() => void session.save()}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Standalone host: owns the session because nothing above it does. Used where a file has
// only this one view (scene items); a host with a Raw view passes its own session to
// `LensView` instead.
export function LensPanel({ fs, path, lensId, config, channelId, reloadTick }: { fs: FsClient; path: string; lensId: string; config?: unknown; channelId: string; reloadTick?: number }) {
  const session = useFileSession(fs, path);
  // Live-push: the Desk changed on the server (a bot finished writing) — re-pull so the
  // default view of machine-written files (metrics, boards) stays live. An unsaved buffer
  // is never clobbered; `reload(true)` keeps it.
  const seenTick = useRef(reloadTick);
  const reload = session.reload;
  useEffect(() => {
    if (reloadTick === undefined || reloadTick === seenTick.current) return;
    seenTick.current = reloadTick;
    void reload(true);
  }, [reloadTick, reload]);

  return <LensView session={session} lensId={lensId} config={config} channelId={channelId} standalone />;
}
