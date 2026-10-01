import { describe, expect, it } from "vitest";
import type { AnnotationTarget, SavedAnnotation } from "@/api/annotations";
import { sameTarget, annotationFeedback } from "./model";
const event: AnnotationTarget = {
  kind: "event",
  msg_id: "message-1",
  event_id: "opening",
  tool_call_id: "tool-1",
  snapshot: { phase: "tool_call", title: "Edit config" },
};
describe("unified annotation references", () => {
  it("keeps comments on the same operation across incremental events, but separates turns", () => {
    expect(sameTarget(event, { ...event, event_id: "update" })).toBe(true);
    expect(sameTarget(event, { ...event, msg_id: "message-2" })).toBe(false);
    expect(
      sameTarget(event, {
        kind: "file",
        path: "opening",
        anchor: { kind: "file" },
      }),
    ).toBe(false);
  });
  it("shows all anchors on the selected file without mixing files", () => {
    const file: AnnotationTarget = {
      kind: "file",
      path: "config.rs",
      anchor: { kind: "file" },
    };
    expect(
      sameTarget(file, {
        ...file,
        anchor: { kind: "text", sourceText: "timeout" },
      }),
    ).toBe(true);
    expect(sameTarget(file, { ...file, path: "other.rs" })).toBe(false);
  });
  it("includes the source and complete comment when preparing agent feedback", () => {
    const note = {
      target: event,
      label: "Edit config",
      note: "Preserve the timeout.",
    } as SavedAnnotation;
    expect(annotationFeedback(note)).toContain("Tool call: tool-1");
    expect(annotationFeedback(note)).toContain("Message: message-1");
    expect(annotationFeedback(note)).toContain("Preserve the timeout.");
  });
});
