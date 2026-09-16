import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnnotationsButton, AnnotationListContent } from "./AnnotationBar";
import type { Annotation } from "./annotations";

const mockNotes: Annotation[] = [
  {
    id: "note-1",
    at: 0,
    path: "tasks/backlog.yaml",
    anchor: { kind: "text", sourceText: "Example task" },
    label: "Example task",
    note: "Review this milestone before sprint ends.",
    created: "2026-09-16T12:00:00.000Z",
  },
  {
    id: "note-2",
    at: 1,
    path: "dev/plan.yaml",
    anchor: { kind: "file" },
    label: "dev/plan.yaml",
    note: "Cross-file note in plan document.",
    created: "2026-09-15T10:00:00.000Z",
  },
];

describe("AnnotationsButton", () => {
  it("renders enabled button even when 0 notes exist", () => {
    const markup = renderToStaticMarkup(
      <AnnotationsButton
        notes={[]}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Annotations"');
    expect(markup).not.toMatch(/\sdisabled(?:=|>|\s)/);
  });

  it("displays note count badge when notes exist", () => {
    const markup = renderToStaticMarkup(
      <AnnotationsButton
        notes={[mockNotes[0]]}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="1 annotation"');
    expect(markup).toContain("bg-accent-400");
  });

  it("shows workspace note indicator when current file is empty but workspace has notes", () => {
    const markup = renderToStaticMarkup(
      <AnnotationsButton
        notes={[]}
        allNotes={mockNotes}
        currentPath="tasks/backlog.yaml"
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Annotations (2 in workspace)"');
    expect(markup).toContain("bg-content-muted");
  });
});

describe("AnnotationListContent", () => {
  it("renders empty state when 0 notes exist", () => {
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[]}
        currentPath="tasks/backlog.yaml"
        onRemove={vi.fn()}
        onAddNote={vi.fn()}
      />,
    );

    // The panel opens from a control already named "annotations" and sits above the
    // list it would count, so a caption and a badge both said what was on screen.
    expect(markup).not.toMatch(/>Annotations</);
    expect(markup).toContain("No annotations on this file");
    // Making one is the same + every other toolbar in the app uses, not a worded
    // button unique to this panel. The empty state keeps its own call to action.
    expect(markup).not.toContain("+ Add note");
    expect(markup).toContain('aria-label="Add note"');
  });

  it("renders scope tabs when notes exist across workspace", () => {
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[mockNotes[0]]}
        allNotes={mockNotes}
        currentPath="tasks/backlog.yaml"
        onRemove={vi.fn()}
      />,
    );

    // Two tabs spent a row of chrome naming the state you were already looking at.
    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain("This file (1)");
    expect(markup).not.toMatch(/>All files \(2\)</);
    // One control carries the state it is in, and its accessible name says what
    // pressing it does — which a tab's "selected" never told anyone.
    expect(markup).toContain("Show all files (2)");
  });

  it("renders note item with line resolution and note text", () => {
    const fileText = "tasks:\n  - Example task\n    owner: alice\n";
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[mockNotes[0]]}
        currentPath="tasks/backlog.yaml"
        text={fileText}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain("Example task");
    expect(markup).toContain("Review this milestone before sprint ends.");
    expect(markup).toContain("L2");
  });

  it("displays stale badge when an anchor no longer resolves", () => {
    const changedText = "tasks:\n  - Changed task\n    owner: alice\n";
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[mockNotes[0]]}
        currentPath="tasks/backlog.yaml"
        text={changedText}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain("stale");
  });
});

describe("AnnotationListContent density", () => {
  it("holds each note to a single line, with the rest a hover away", () => {
    const markup = renderToStaticMarkup(
      <AnnotationListContent
        notes={[mockNotes[0]]}
        currentPath="tasks/backlog.yaml"
        onRemove={vi.fn()}
      />,
    );

    // A note is a remark, not a document: one wrapping to four lines pushes the
    // rest off a list you opened in order to scan it.
    expect(markup).toContain("truncate");
    expect(markup).not.toContain("whitespace-pre-wrap");
    expect(markup).toContain(`title="${mockNotes[0].note}"`);
  });

  it("marks the panel with the annotation icon, not a chat bubble", () => {
    const markup = renderToStaticMarkup(
      <AnnotationListContent notes={[]} currentPath="tasks/backlog.yaml" onRemove={vi.fn()} />,
    );

    // The register carries its own mark for a note left in the margin; a speech
    // bubble is what the chat surfaces use for a message.
    expect(markup).toContain('stroke-width="1.75"');
    expect(markup).toContain("M13.5 4.5v5h5");
  });
});
