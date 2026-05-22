import type { DragEvent } from "react";

export const AGENTNEXUS_FILE_DRAG_TYPE = "application/x-agentnexus-file";

export interface FileDragReference {
  file_id: string;
  original_filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
}

export function dragEventHasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function filesFromDragEvent(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer.files);
}

export function dragEventHasFileReferences(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(AGENTNEXUS_FILE_DRAG_TYPE);
}

export function fileReferencesFromDragEvent(
  event: DragEvent<HTMLElement>,
): FileDragReference[] {
  const raw = event.dataTransfer.getData(AGENTNEXUS_FILE_DRAG_TYPE);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.filter(isFileDragReference);
  } catch {
    return [];
  }
}

export function setFileReferenceDragData(
  event: DragEvent<HTMLElement>,
  references: FileDragReference[],
) {
  const validReferences = references.filter(isFileDragReference);
  if (validReferences.length === 0) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(
    AGENTNEXUS_FILE_DRAG_TYPE,
    JSON.stringify(validReferences),
  );
  event.dataTransfer.setData(
    "text/plain",
    validReferences
      .map((file) => file.original_filename || file.file_id)
      .join("\n"),
  );
}

function isFileDragReference(value: unknown): value is FileDragReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.file_id === "string" && item.file_id.trim().length > 0;
}
