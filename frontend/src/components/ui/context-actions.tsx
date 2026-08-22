import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { placeNearRect } from "./floating-layer";
import { MenuOption } from "./menu-option";

export type ContextActionGroup = "primary" | "secondary" | "danger";

export interface ContextAction {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  group?: ContextActionGroup;
  run: () => void | Promise<void>;
}

export interface SelectionActionContext {
  text: string;
  rect: DOMRect;
  isCode: boolean;
}

type SurfaceSource = "pointer" | "keyboard" | "selection" | "touch";

interface OpenRequest {
  actions: ContextAction[];
  anchor: DOMRect;
  source: SurfaceSource;
  restoreFocus?: HTMLElement | null;
}

interface ContextActionsValue {
  open: (request: OpenRequest) => void;
  close: (restoreFocus?: boolean) => void;
}

const FALLBACK_CONTEXT: ContextActionsValue = { open: () => {}, close: () => {} };
const ContextActionsContext = createContext<ContextActionsValue>(FALLBACK_CONTEXT);

const NATIVE_CONTEXT_SELECTOR = [
  "input",
  "textarea",
  "select",
  "option",
  "[contenteditable]:not([contenteditable='false'])",
  "a[href]",
  "audio",
  "video",
  ".cm-editor",
].join(",");

export function preservesNativeContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(NATIVE_CONTEXT_SELECTOR));
}

export function pointRect(x: number, y: number): DOMRect {
  return new DOMRect(x, y, 0, 0);
}

export function quoteSelectedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function selectionInSurface(
  surface: HTMLElement,
  selection: Selection | null = window.getSelection(),
): SelectionActionContext | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0);
  if (
    !surface.contains(range.startContainer) ||
    !surface.contains(range.endContainer) ||
    !surface.contains(range.commonAncestorContainer)
  ) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (!Number.isFinite(rect.left) || (!rect.width && !rect.height)) return null;
  const codeElement =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer.closest("pre, code")
      : range.commonAncestorContainer.parentElement?.closest("pre, code");
  return { text, rect, isCode: Boolean(codeElement) };
}

function available(actions: ContextAction[]) {
  return actions.filter((action) => action.label.trim().length > 0);
}

function ContextActionsOverlay({
  request,
  onClose,
}: {
  request: OpenRequest;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const actions = useMemo(() => available(request.actions), [request.actions]);
  const isToolbar = request.source === "selection";
  const isSheet = request.source === "touch";

  useLayoutEffect(() => {
    if (isSheet) return;
    const panel = panelRef.current;
    if (!panel) return;
    const update = () => {
      const rect = panel.getBoundingClientRect();
      const preferred = isToolbar ? "up" : "down";
      setPosition(placeNearRect(request.anchor, rect.width, rect.height, preferred));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isSheet, isToolbar, request.anchor]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (!isToolbar) panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [isToolbar]);

  useEffect(() => {
    const closeWithoutFocus = () => onClose(false);
    window.addEventListener("scroll", closeWithoutFocus, true);
    return () => window.removeEventListener("scroll", closeWithoutFocus, true);
  }, [onClose]);

  const run = async (action: ContextAction) => {
    if (action.disabled) return;
    try {
      await action.run();
      onClose(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const backwards = event.key === "ArrowUp" || event.key === "ArrowLeft";
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (current + (backwards ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  let previousGroup: ContextActionGroup | undefined;
  const items = actions.map((action) => {
    const group = action.group ?? "primary";
    const divider = previousGroup !== undefined && group !== previousGroup;
    previousGroup = group;
    return (
      <div key={action.id} className={cn(divider && !isToolbar && "mt-1 border-t border-zinc-800 pt-1")}>
        <MenuOption
          label={action.label}
          leading={action.icon ?? <span aria-hidden="true" className="h-4 w-4" />}
          trailing={action.shortcut ? <kbd className="text-minimal text-content-muted">{action.shortcut}</kbd> : undefined}
          disabled={action.disabled}
          controlSize="regular"
          onMouseDown={isToolbar ? (event) => event.preventDefault() : undefined}
          onClick={() => void run(action)}
          className={cn(
            isToolbar && "w-auto min-w-0 px-2",
            group === "danger" && "text-danger-400 hover:text-danger-300",
          )}
        />
      </div>
    );
  });

  const panel = (
    // The dynamic menu/toolbar role supplies the interaction semantics; this
    // wrapper owns delegated keyboard handling for its native buttons.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={panelRef}
      role={isToolbar ? "toolbar" : "menu"}
      aria-label={isToolbar ? "Selected text actions" : "Context actions"}
      onKeyDown={handleKeyDown}
      data-context-actions="true"
      className={cn(
        "z-[110] bg-zinc-900 font-utility text-regular shadow-xl shadow-black/40 ring-1 ring-zinc-700/80",
        isToolbar
          ? "flex items-center gap-1 rounded-sm p-1"
          : "w-56 max-w-[calc(100vw-1rem)] rounded-concentric p-1 [--concentric-inset:0.25rem]",
        isSheet && "fixed inset-x-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] w-auto rounded-concentric p-2",
      )}
      style={
        isSheet
          ? undefined
          : {
              position: "fixed",
              left: position?.x ?? 0,
              top: position?.y ?? 0,
              visibility: position ? "visible" : "hidden",
            }
      }
    >
      {items}
    </div>
  );

  return createPortal(
    <>
      {isSheet && (
        <button
          type="button"
          aria-label="Close context actions"
          className="fixed inset-0 z-[109] cursor-default bg-black/45"
          onClick={() => onClose(true)}
        />
      )}
      {panel}
    </>,
    document.body,
  );
}

export function ContextActionsProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const requestRef = useRef<OpenRequest | null>(null);

  const close = useCallback((restoreFocus = false) => {
    const previous = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    if (restoreFocus) window.setTimeout(() => previous?.restoreFocus?.focus(), 0);
  }, []);

  const open = useCallback((next: OpenRequest) => {
    const normalized = { ...next, actions: available(next.actions) };
    if (!normalized.actions.length) return;
    requestRef.current = normalized;
    setRequest(normalized);
  }, []);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-context-actions='true']")) return;
      close(false);
    };
    const onSelectionChange = () => {
      if (requestRef.current?.source === "selection" && window.getSelection()?.isCollapsed) {
        close(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [close]);

  const value = useMemo(() => ({ open, close }), [close, open]);
  return (
    <ContextActionsContext.Provider value={value}>
      {children}
      {request && <ContextActionsOverlay request={request} onClose={close} />}
    </ContextActionsContext.Provider>
  );
}

export function useContextActions() {
  return useContext(ContextActionsContext);
}

export function useContextSurface({
  surfaceRef,
  actions,
  selectionActions,
  disabled = false,
}: {
  surfaceRef: RefObject<HTMLElement | null>;
  actions: () => ContextAction[];
  selectionActions?: (selection: SelectionActionContext) => ContextAction[];
  disabled?: boolean;
}) {
  const { open, close } = useContextActions();
  const actionsRef = useRef(actions);
  const selectionActionsRef = useRef(selectionActions);
  const longPressRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  actionsRef.current = actions;
  selectionActionsRef.current = selectionActions;

  const clearLongPress = useCallback(() => {
    if (longPressRef.current !== null) window.clearTimeout(longPressRef.current);
    longPressRef.current = null;
    startRef.current = null;
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const openSelection = useCallback(() => {
    const surface = surfaceRef.current;
    const makeActions = selectionActionsRef.current;
    if (!surface || !makeActions) return false;
    const selection = selectionInSurface(surface);
    if (!selection) return false;
    const next = makeActions(selection);
    if (!available(next).length) return false;
    open({ actions: next, anchor: selection.rect, source: "selection", restoreFocus: surface });
    return true;
  }, [open, surfaceRef]);

  return {
    onContextMenu(event: ReactMouseEvent<HTMLElement>) {
      if (disabled || preservesNativeContextMenu(event.target)) return;
      const surface = surfaceRef.current;
      if (!surface) return;
      const selection = selectionInSurface(surface);
      const next = selection && selectionActionsRef.current
        ? selectionActionsRef.current(selection)
        : actionsRef.current();
      if (!available(next).length) return;
      event.preventDefault();
      event.stopPropagation();
      open({
        actions: next,
        anchor: selection?.rect ?? pointRect(event.clientX, event.clientY),
        // A right click is always a context menu. Selection toolbars are reserved
        // for the immediate left-button selection gesture in `onMouseUp`.
        source: "pointer",
        restoreFocus: surface,
      });
    },
    onMouseUp(event: ReactMouseEvent<HTMLElement>) {
      if (disabled || event.button !== 0 || preservesNativeContextMenu(event.target)) return;
      window.requestAnimationFrame(() => {
        if (!openSelection()) close(false);
      });
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
      if (disabled || preservesNativeContextMenu(event.target)) return;
      if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      const surface = surfaceRef.current;
      const next = actionsRef.current();
      if (!surface || !available(next).length) return;
      event.preventDefault();
      open({ actions: next, anchor: surface.getBoundingClientRect(), source: "keyboard", restoreFocus: surface });
    },
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (disabled || event.pointerType === "mouse" || preservesNativeContextMenu(event.target)) return;
      clearLongPress();
      startRef.current = { x: event.clientX, y: event.clientY };
      const target = event.currentTarget;
      longPressRef.current = window.setTimeout(() => {
        const next = actionsRef.current();
        longPressRef.current = null;
        if (!available(next).length) return;
        suppressClickRef.current = true;
        navigator.vibrate?.(10);
        open({ actions: next, anchor: target.getBoundingClientRect(), source: "touch", restoreFocus: target });
      }, 500);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const start = startRef.current;
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) clearLongPress();
    },
    onPointerUp: clearLongPress,
    onPointerCancel: clearLongPress,
    onPointerLeave: clearLongPress,
    onClickCapture(event: ReactMouseEvent<HTMLElement>) {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
