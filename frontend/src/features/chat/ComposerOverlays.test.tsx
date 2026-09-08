import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerMentionPicker } from "./ComposerOverlays";

describe("ComposerMentionPicker", () => {
  it("renders a roster avatar for a member candidate", () => {
    const markup = renderToStaticMarkup(
      <ComposerMentionPicker
        candidates={[{
          id: "user-1",
          type: "user",
          label: "Alice",
          avatarUrl: "https://example.test/alice.png",
        }]}
        activeIndex={0}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('src="https://example.test/alice.png"');
    expect(markup).toContain('alt="Alice"');
  });
});
