import { apiJson } from "./client";
import type { AnnotationAnchor } from "@/features/annotations/types";
export type AnnotationTarget =
  | { kind: "file"; path: string; anchor: AnnotationAnchor }
  | {
      kind: "event";
      msg_id: string;
      event_id: string;
      tool_call_id?: string | null;
      snapshot: {
        title?: string | null;
        phase: string;
        status?: string | null;
        bot_id?: string | null;
        kind?: string;
        channel_seq?: number | null;
        presentation?: Record<string, unknown> | null;
      };
    };
export interface SavedAnnotation {
  id: string;
  channel_id: string;
  author_id: string | null;
  target: AnnotationTarget;
  label: string;
  note: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface AnnotationInput {
  target: AnnotationTarget;
  label: string;
  note: string;
}
const base = (channel: string) =>
  `/channels/${encodeURIComponent(channel)}/annotations`;
export const listAnnotations = (channel: string) =>
  apiJson<{ notes: SavedAnnotation[]; import_warning: string | null }>(
    base(channel),
  );
export const createAnnotation = (channel: string, input: AnnotationInput) =>
  apiJson<SavedAnnotation>(base(channel), {
    method: "POST",
    body: JSON.stringify(input),
  });
export const editAnnotation = (
  channel: string,
  item: SavedAnnotation,
  note: string,
) =>
  apiJson<SavedAnnotation>(`${base(channel)}/${item.id}`, {
    method: "PATCH",
    body: JSON.stringify({ note, revision: item.revision }),
  });
export const deleteAnnotation = (channel: string, item: SavedAnnotation) =>
  apiJson(`${base(channel)}/${item.id}`, {
    method: "DELETE",
    body: JSON.stringify({ revision: item.revision }),
  });
