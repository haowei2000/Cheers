import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MenuOption } from "./menu-option";

export interface ContextMenuAction {
  label: ReactNode;
  leading?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

interface ContextMenuState<T> {
  x: number;
  y: number;
  target: T;
}

/** State shared by pointer context-menu triggers and the portalled menu surface. */
export function useContextMenu<T>() {
  const [state, setState] = useState<ContextMenuState<T> | null>(null);
  const open = useCallback((event: ReactMouseEvent, target: T) => {
    event.preventDefault();
    setState({ x: event.clientX, y: event.clientY, target });
  }, []);
  const openAt = useCallback((x: number, y: number, target: T) => {
    setState({ x, y, target });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { state, open, openAt, close };
}

/**
 * Desktop-style contextual action menu. It is portalled and viewport-clamped so
 * floating Workbench windows cannot clip it. Visible toolbar actions remain the
 * keyboard/touch alternative; this menu is an additional pointer shortcut.
 */
export function ContextMenu({
  state,
  onClose,
  actions,
  ariaLabel = "Context menu",
}: {
  state: { x: number; y: number } | null;
  onClose: () => void;
  actions: ContextMenuAction[];
  ariaLabel?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)'
    );
    if (first) first.focus();
    else menuRef.current?.focus();

    const dismiss = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const dismissWindow = () => onClose();
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismissWindow);
    window.addEventListener("resize", dismissWindow);
    window.addEventListener("scroll", dismissWindow, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismissWindow);
      window.removeEventListener("resize", dismissWindow);
      window.removeEventListener("scroll", dismissWindow, true);
    };
  }, [state, onClose]);

  if (!state || typeof document === "undefined") return null;

  const width = 224;
  const estimatedHeight = actions.length * 36 + 8;
  const left = Math.max(8, Math.min(state.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(state.y, window.innerHeight - estimatedHeight - 8));

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="fixed z-[1000] w-56 overflow-hidden rounded-sm bg-zinc-900 p-1 shadow-xl shadow-black/50 ring-1 ring-zinc-700/80"
      style={{ left, top }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not(:disabled)'
          ) ?? []
        );
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        let next = current;
        if (event.key === "ArrowDown") next = (current + 1) % items.length;
        else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = items.length - 1;
        else return;
        event.preventDefault();
        items[next]?.focus();
      }}
    >
      {actions.map((action, index) => (
        <MenuOption
          key={index}
          label={action.label}
          leading={action.leading}
          disabled={action.disabled}
          onClick={() => {
            action.onSelect();
            onClose();
          }}
        />
      ))}
    </div>,
    document.body
  );
}
