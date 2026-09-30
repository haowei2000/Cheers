import {
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { AddContextIcon } from "@/components/ui/editorial-icons";
import {
  pointRect,
  preservesNativeContextMenu,
  useContextActions,
  useContextSurface,
  type ContextAction,
} from "@/components/ui/context-actions";
import {
  rangedFileContextItem,
  selectionLineRange,
  useContextPickStore,
  usePendingContext,
  workbenchFileContextItem,
} from "@/features/chat/context/contextPick";

export function ContextPickSurface({
  channelId,
  path,
  content,
  children,
  onAdded,
}: {
  channelId: string;
  path: string;
  content: string;
  children: ReactNode;
  onAdded: (label: string) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { open } = useContextActions();
  const addContext = useContextPickStore((state) => state.add);
  const picked = usePendingContext(channelId);
  const item = workbenchFileContextItem(path);
  const added = picked.some((candidate) => candidate.id === item.id);
  const actions = () => [{
    id: "add-context",
    label: added ? "Already added to context" : "Add to context",
    icon: <AddContextIcon className="h-4 w-4" />,
    disabled: added,
    run: () => {
      addContext(channelId, item);
      onAdded(item.label);
    },
  } satisfies ContextAction];
  const contextSurface = useContextSurface({
    surfaceRef,
    actions,
    selectionActions: (selection) => {
      const range = selectionLineRange(content, selection.text);
      return [{
        id: "add-lines",
        label: "Add selected lines to context",
        icon: <AddContextIcon className="h-4 w-4" />,
        disabled: !range,
        run: () => {
          if (!range) throw new Error("The selected text could not be mapped to file lines");
          const ranged = rangedFileContextItem(path, range.start, range.end);
          addContext(channelId, ranged);
          onAdded(ranged.label);
        },
      } satisfies ContextAction];
    },
  });

  const onContextMenuCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest("[data-workbench-context-target]")) return;
    if (!preservesNativeContextMenu(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    open({
      actions: actions(),
      anchor: pointRect(event.clientX, event.clientY),
      source: "pointer",
      restoreFocus: event.target instanceof HTMLElement ? event.target : surfaceRef.current,
    });
  };

  return (
    <div
      ref={surfaceRef}
      className="h-full min-h-0"
      tabIndex={0}
      onContextMenuCapture={onContextMenuCapture}
      onContextMenu={contextSurface.onContextMenu}
      onMouseUp={contextSurface.onMouseUp}
      onKeyDown={contextSurface.onKeyDown}
      onPointerDown={contextSurface.onPointerDown}
      onPointerMove={contextSurface.onPointerMove}
      onPointerUp={contextSurface.onPointerUp}
      onPointerCancel={contextSurface.onPointerCancel}
      onPointerLeave={contextSurface.onPointerLeave}
      onClickCapture={contextSurface.onClickCapture}
    >
      {children}
    </div>
  );
}
