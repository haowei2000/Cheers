import { useRef, type PointerEvent as ReactPointerEvent } from "react";

// Vertical splitter between the chat column and the work lane. Dragging it left
// widens the lane (the right column) and narrows the chat; dragging right does
// the reverse. Width is clamped live against the parent flex row so neither
// column collapses below its floor. Desktop only — on mobile the lane is a
// full-screen overlay sheet with no side-by-side split to resize.
//
// The parent element MUST be the flex row that holds [chat | this | lane]; the
// handle reads that row's rect to convert the cursor X into a lane width
// (row.right − cursorX).
export function LaneResizer({
  onChange,
  onCommit,
  minLane = 256, // 16rem — matches the lane's md:min-w (tight mid-width floor)
  minChat = 320, // 20rem — matches the chat column's md:min-w; CSS raises to 24rem ≥1100px
}: {
  /** Live lane width (px) while dragging. */
  onChange: (widthPx: number) => void;
  /** Drag ended — persist the final width. */
  onCommit: () => void;
  minLane?: number;
  minChat?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onDown = (e: ReactPointerEvent) => {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault(); // no text selection while dragging
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const row = ref.current?.parentElement;
    if (!row) return;
    const r = row.getBoundingClientRect();
    // Mirror ChannelView's adaptive chat floor so the splitter and CSS agree.
    const chatFloor = r.width < 1100 ? minChat : Math.max(minChat, 384);
    const maxLane = Math.max(minLane, r.width - chatFloor);
    const w = Math.min(Math.max(r.right - e.clientX, minLane), maxLane);
    onChange(Math.round(w));
  };
  const onUp = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    onCommit();
  };

  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize work lane"
      title="Drag to resize"
      className="group relative w-1.5 shrink-0 cursor-col-resize max-md:hidden"
      style={{ touchAction: "none" }}
    >
      {/* The 6px-wide invisible target keeps resizing discoverable through its
          cursor and title without drawing a permanent divider between regions. */}
    </div>
  );
}
