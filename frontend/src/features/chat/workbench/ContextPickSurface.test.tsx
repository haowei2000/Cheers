import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPickSurface } from "./ContextPickSurface";

describe("ContextPickSurface", () => {
  it("renders with region role, accessible label, and visible focus styles", () => {
    const markup = renderToStaticMarkup(
      <ContextPickSurface
        channelId="test-chan"
        path="src/main.rs"
        content="fn main() {}"
        onAdded={() => {}}
      >
        <div data-testid="child">Editor content</div>
      </ContextPickSurface>
    );

    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Workbench content: src/main.rs"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("focus-visible:ring-1");
    expect(markup).toContain("Editor content");
  });
});
