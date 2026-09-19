import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchCardDeck, type WorkbenchCardItem } from "./WorkbenchCardDeck";

const sampleTabs: WorkbenchCardItem[] = [
  {
    path: "notes/overview.md",
    label: "overview.md",
    rendererTitle: "Markdown",
    previewSnippet: "This is a document overview...",
  },
  {
    path: "src/main.rs",
    label: "main.rs",
    isDirty: true,
    hasContext: true,
    noteCount: 2,
    previewSnippet: "fn main() { println!(\"hello\"); }",
  },
];

describe("WorkbenchCardDeck", () => {
  it("renders tabs as full-page cards with active card content and inactive preview", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchCardDeck
        tabs={sampleTabs}
        selectedPath="src/main.rs"
        onSelectTab={() => {}}
        renderActiveCardContent={(path) => (
          <div data-testid="active-editor">Active editor for {path}</div>
        )}
      />,
    );

    expect(markup).toContain('aria-label="Workbench card stream"');
    expect(markup).toContain("overview.md");
    expect(markup).toContain("main.rs");
    expect(markup).toContain("Active editor for src/main.rs");
    expect(markup).toContain("This is a document overview...");
    expect(markup).toContain('title="Unsaved changes"');
    expect(markup).toContain('aria-label="Added to context"');
    expect(markup).toContain("2 notes");
    expect(markup).toContain("bg-canvas");
    expect(markup).not.toContain("bg-panel");
  });

  it("renders locked state badge and keeps card header free of action buttons", () => {
    const unlockedMarkup = renderToStaticMarkup(
      <WorkbenchCardDeck
        tabs={sampleTabs}
        selectedPath="src/main.rs"
        onSelectTab={() => {}}
        renderActiveCardContent={() => <div>content</div>}
        isLocked={false}
      />,
    );
    expect(unlockedMarkup).not.toContain("Locked");
    expect(unlockedMarkup).not.toContain("<button");

    const lockedMarkup = renderToStaticMarkup(
      <WorkbenchCardDeck
        tabs={sampleTabs}
        selectedPath="src/main.rs"
        onSelectTab={() => {}}
        renderActiveCardContent={() => <div>content</div>}
        isLocked={true}
      />,
    );
    expect(lockedMarkup).toContain("Locked");
    expect(lockedMarkup).not.toContain("<button");
  });

  it("renders empty state when there are no tabs", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchCardDeck
        tabs={[]}
        selectedPath={null}
        onSelectTab={() => {}}
        renderActiveCardContent={() => null}
      />,
    );

    expect(markup).toContain("No tabs in this collection");
  });
});
