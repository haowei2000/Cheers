import type { AnnotationTarget, SavedAnnotation } from "@/api/annotations";
import type { TraceEvent } from "@/types";
export function sameTarget(a: AnnotationTarget, b: AnnotationTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  if (a.kind === "event" && b.kind === "event")
    return (
      a.msg_id === b.msg_id &&
      (a.tool_call_id && b.tool_call_id
        ? a.tool_call_id === b.tool_call_id
        : a.event_id === b.event_id)
    );
  return false;
}
export function eventTarget(event: TraceEvent): AnnotationTarget {
  return {
    kind: "event",
    msg_id: event.msg_id,
    event_id: event.event_id ?? event.id,
    tool_call_id: event.tool_call_id,
    snapshot: { title: event.title, phase: event.phase, status: event.status },
  };
}
export function annotationFeedback(item: SavedAnnotation): string {
  const source =
    item.target.kind === "file"
      ? `File: ${item.target.path}\nAnchor: ${JSON.stringify(item.target.anchor)}`
      : `Message: ${item.target.msg_id}\nEvent: ${item.target.event_id}\n${item.target.tool_call_id ? `Tool call: ${item.target.tool_call_id}\n` : ""}Context: ${JSON.stringify(item.target.snapshot)}`;
  return `Please address this annotation.\n\n${item.label}\n${source}\n\n${item.note}`;
}
