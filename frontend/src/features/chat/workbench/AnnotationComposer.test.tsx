import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnnotationComposer, anchorOfTarget, type PendingAnnotation } from "./AnnotationComposer";

describe("AnnotationComposer", () => {
  const samplePending: PendingAnnotation = {
    target: {
      label: "Component Header",
      sourcePath: ["components", 0],
    },
    path: "src/App.tsx",
    at: { x: 150, y: 200 },
  };

  it("renders accessible dialog shell with target label", () => {
    const markup = renderToStaticMarkup(
      <AnnotationComposer
        pending={samplePending}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Note on Component Header"');
    expect(markup).toContain("Component Header");
    expect(markup).toContain("Cancel");
    expect(markup).toContain('aria-label="Save note"');
  });

  it("renders textarea with accessible label and placeholder", () => {
    const markup = renderToStaticMarkup(
      <AnnotationComposer
        pending={samplePending}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(markup).toContain('aria-label="Annotation note content"');
    expect(markup).toContain('placeholder="What should be said about this?"');
  });

  it("uses design system tokens and elevation-overlay for dialog shell", () => {
    const markup = renderToStaticMarkup(
      <AnnotationComposer
        pending={samplePending}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(markup).toContain("elevation-overlay");
    expect(markup).toContain("bg-panel");
    expect(markup).toContain("ring-control/40");
    expect(markup).toContain("rounded-concentric");
  });
});

describe("anchorOfTarget", () => {
  it("converts desk locator URI targets", () => {
    const anchor = anchorOfTarget({
      label: "Row 1",
      inspectableId: "row-1",
      locator: "cheers://desk/tasks.yaml#row-1",
    });
    expect(anchor).toEqual({
      kind: "uri",
      uri: "cheers://desk/tasks.yaml#row-1",
    });
  });

  it("converts AST sourcePath targets", () => {
    const anchor = anchorOfTarget({
      label: "Column 2",
      sourcePath: ["columns", 1],
    });
    expect(anchor).toEqual({
      kind: "path",
      sourcePath: ["columns", 1],
    });
  });

  it("converts sourceText prose targets", () => {
    const anchor = anchorOfTarget({
      label: "Quote",
      sourceText: "Specific sentence",
    });
    expect(anchor).toEqual({
      kind: "text",
      sourceText: "Specific sentence",
    });
  });

  it("falls back to file anchor when neither is present", () => {
    const anchor = anchorOfTarget({
      label: "Document",
    });
    expect(anchor).toEqual({
      kind: "file",
    });
  });
});
