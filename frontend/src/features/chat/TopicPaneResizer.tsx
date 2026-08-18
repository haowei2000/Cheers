import { useRef, type PointerEvent as ReactPointerEvent } from "react";

/** Vertical splitter that sets the LEFT pane width. Parent must be the flex
 *  row holding [left | this | right]. Desktop only — hidden below `md`. */
export function TopicPaneResizer({
  onChange,
  onCommit,
  minLeft = 260,
  minRight = 360,
}: {
  onChange: (widthPx: number) => void;
  onCommit: (widthPx: number) => void;
  minLeft?: number;
  minRight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const width = useRef<number | null>(null);

  const onDown = (e: ReactPointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const row = ref.current?.parentElement;
    if (!row) return;
    const r = row.getBoundingClientRect();
    const maxLeft = Math.max(minLeft, r.width - minRight);
    const w = Math.round(Math.min(Math.max(e.clientX - r.left, minLeft), maxLeft));
    width.current = w;
    onChange(w);
  };
  const onUp = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    if (width.current !== null) onCommit(width.current);
  };

  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize discussion panes"
      title="Drag to resize"
      className="group relative w-1.5 flex-shrink-0 cursor-col-resize max-md:hidden"
      style={{ touchAction: "none" }}
    />
  );
}
