import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SuggestedQuestionsComposerBanner } from "./SuggestedQuestionsComposerBanner";

describe("SuggestedQuestionsComposerBanner", () => {
  const questions = [
    { text: "What is in {{file:main.rs}}?", slots: [{ key: "main.rs", kind: "file" as const }] },
    { text: "How to run tests?", slots: [] },
  ];

  it("returns null when questions list is empty", () => {
    const markup = renderToStaticMarkup(
      <SuggestedQuestionsComposerBanner
        questions={[]}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(markup).toBe("");
  });

  it("renders questions with slot markers formatted and highlights selected question", () => {
    const markup = renderToStaticMarkup(
      <SuggestedQuestionsComposerBanner
        questions={questions}
        selectedIndex={0}
        onSelect={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(markup).toContain("What is in [file]?");
    expect(markup).toContain("How to run tests?");
    expect(markup).toContain('aria-label="Suggested questions"');
    expect(markup).toContain('aria-label="Dismiss suggestions"');
    // First question should have data-selected="true"
    expect(markup).toContain('data-selected="true"');
  });
});
