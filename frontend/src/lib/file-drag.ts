import type { DragEvent } from "react";

export function dragEventHasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function filesFromDragEvent(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer.files);
}
