import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PathOpenContext } from "@/features/chat/workspaceLink";

describe("MarkdownRenderer workspace references", () => {
  it("keeps the path visible instead of replacing it with an Open button label", () => {
    const markup = renderToStaticMarkup(
      <PathOpenContext.Provider value={vi.fn()}>
        <MarkdownRenderer content="See `frontend/src` and `server/Cargo.toml`." />
      </PathOpenContext.Provider>,
    );

    expect(markup).toContain("data-inline-reference");
    expect(markup).toContain("frontend/src");
    expect(markup).toContain("server/Cargo.toml");
    expect(markup).not.toContain(">Open<");
  });

  it("leaves ordinary inline code non-interactive", () => {
    const markup = renderToStaticMarkup(
      <PathOpenContext.Provider value={vi.fn()}>
        <MarkdownRenderer content="Run `git status`." />
      </PathOpenContext.Provider>,
    );

    expect(markup).not.toContain("data-inline-reference");
    expect(markup).toContain("git status");
  });
});
