import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnnotationsButton, AnnotationListContent, formatNoteDate } from "./AnnotationsButton";
import type { Annotation } from "./annotations";

const sampleNotes: Annotation[] = [
  {
    id: "n-1",
    at: 0,
    path: "docs/spec.md",
    anchor: { kind: "text", sourceText: "Phase 1" },
    label: "Phase 1",
    note: "Must verify backwards compatibility before release.",
    created: "2026-09-30T10:00:00.000Z",
  },
  {
    id: "n-2",
    at: 1,
    path: "docs/overview.md",
    anchor: { kind: "file" },
    label: "overview.md",
    note: "High-level architectural summary.",
    created: "2025-01-01T08:00:00.000Z",
  },
];

describe("AnnotationsButton module exports", () => {
  it("renders AnnotationsButton with zero notes", () => {
    const markup = renderToStaticMarkup(
      <AnnotationsButton notes={[]} onRemove={vi.fn()} />
    );
    expect(markup).toContain('aria-label="Annotations"');
  });

  it("renders AnnotationsButton with count badge and expanded status", () => {
    const markup = renderToStaticMarkup(
      <AnnotationsButton
        notes={[sampleNotes[0]]}
        defaultOpen={true}
        onRemove={vi.fn()}
      />
    );
    expect(markup).toContain('aria-label="1 annotation"');
    expect(markup).toContain('aria-expanded="true"');
  });
});

describe("AnnotationListContent keyboard & accessibility", () => {
  it("renders semantic list and list items with focus styles", () => {
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[sampleNotes[0]]}
        currentPath="docs/spec.md"
        onRemove={vi.fn()}
      />
    );

    expect(markup).toContain('role="list"');
    expect(markup).toContain('role="listitem"');
    expect(markup).toContain("focus-visible:ring-accent-500");
    expect(markup).toContain("Phase 1");
    expect(markup).toContain("Must verify backwards compatibility before release.");
  });

  it("marks active annotation with aria-current", () => {
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[sampleNotes[0]]}
        activeAnnotationId="n-1"
        currentPath="docs/spec.md"
        onRemove={vi.fn()}
      />
    );

    expect(markup).toContain('aria-current="true"');
  });
});

describe("formatNoteDate helper", () => {
  it("formats dates gracefully", () => {
    expect(formatNoteDate(undefined)).toBeNull();
    expect(formatNoteDate("invalid-date")).toBeNull();
    const formatted = formatNoteDate("2026-09-30T10:00:00.000Z");
    expect(formatted).toBeTruthy();
    expect(formatted).toMatch(/\d+\/\d+/);
  });
});
