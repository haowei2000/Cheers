import type { DragEvent } from "react";

export const AGENTNEXUS_FILE_REF_MIME = "application/x-agentnexus-file-ref";
export const AGENTNEXUS_FILE_DRAG_TYPE = "application/x-agentnexus-file";

export interface FileDragReference {
  file_id: string;
  original_filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  status?: string | null;
  expires_at?: string | null;
  channel_id?: string | null;
  channel_label?: string | null;
  scope_type?: string | null;
  scope_id?: string | null;
  summary_3lines?: string | null;
  created_at?: string | null;
}

export function dragEventHasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function filesFromDragEvent(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer.files);
}

export function dragEventHasFileReferences(event: DragEvent<HTMLElement>): boolean {
  const types = Array.from(event.dataTransfer.types);
  return (
    types.includes(AGENTNEXUS_FILE_DRAG_TYPE) ||
    types.includes(AGENTNEXUS_FILE_REF_MIME)
  );
}

export function dragEventHasAgentNexusFiles(event: DragEvent<HTMLElement>): boolean {
  return dragEventHasFileReferences(event);
}

export function dragEventHasFilesOrRefs(event: DragEvent<HTMLElement>): boolean {
  return dragEventHasFiles(event) || dragEventHasFileReferences(event);
}

function minimalFileReference(file: FileDragReference): FileDragReference | null {
  if (!file.file_id) return null;
  return {
    file_id: file.file_id,
    original_filename: file.original_filename,
    content_type: file.content_type,
    size_bytes: file.size_bytes,
    status: file.status,
    expires_at: file.expires_at,
    channel_id: file.channel_id,
    channel_label: file.channel_label,
    scope_type: file.scope_type,
    scope_id: file.scope_id,
    summary_3lines: file.summary_3lines,
    created_at: file.created_at,
  };
}

function isFileDragReference(value: unknown): value is FileDragReference {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.file_id === "string" && item.file_id.trim().length > 0;
}

function parseFileReferences(raw: string): FileDragReference[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items
      .filter(isFileDragReference)
      .map(minimalFileReference)
      .filter((file): file is FileDragReference => Boolean(file));
  } catch {
    return [];
  }
}

export function fileReferencesFromDragEvent(
  event: DragEvent<HTMLElement>,
): FileDragReference[] {
  for (const type of [AGENTNEXUS_FILE_DRAG_TYPE, AGENTNEXUS_FILE_REF_MIME]) {
    const references = parseFileReferences(event.dataTransfer.getData(type));
    if (references.length > 0) return references;
  }
  return [];
}

export function agentNexusFileRefsFromDragEvent(
  event: DragEvent<HTMLElement>,
): FileDragReference[] {
  return fileReferencesFromDragEvent(event);
}

function setFileReferences(
  dataTransfer: DataTransfer,
  references: FileDragReference[],
): boolean {
  const validReferences = references
    .map(minimalFileReference)
    .filter((file): file is FileDragReference => Boolean(file));
  if (validReferences.length === 0) return false;
  const serialized = JSON.stringify(validReferences);
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(AGENTNEXUS_FILE_DRAG_TYPE, serialized);
  dataTransfer.setData(AGENTNEXUS_FILE_REF_MIME, serialized);
  dataTransfer.setData(
    "text/plain",
    validReferences
      .map((file) => file.original_filename || file.file_id)
      .join("\n"),
  );
  return true;
}

export function setFileReferenceDragData(
  event: DragEvent<HTMLElement>,
  references: FileDragReference[],
): boolean {
  return setFileReferences(event.dataTransfer, references);
}

export function setAgentNexusFileRefs(
  dataTransfer: DataTransfer,
  files: FileDragReference[],
): boolean {
  return setFileReferences(dataTransfer, files);
}
