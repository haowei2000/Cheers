import type { DragEventHandler, ReactNode } from "react";
import { DragOverlay } from "../DragOverlay";

interface ChannelMainFrameProps {
  children: ReactNode;
  isDark: boolean;
  isDraggingOver: boolean;
  onDragEnter: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  selectedId: string | null;
}

export function ChannelMainFrame({
  children,
  isDark,
  isDraggingOver,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  selectedId,
}: ChannelMainFrameProps) {
  return (
    <main
      className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden relative"
      style={{ background: "var(--bg-0)" }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <DragOverlay visible={isDraggingOver && !!selectedId} isDark={isDark} />
      {children}
    </main>
  );
}
