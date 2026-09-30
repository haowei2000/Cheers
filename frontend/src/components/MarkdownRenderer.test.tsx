import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { PathOpenContext } from "@/features/chat/workspaceLink";
import { LocatorOpenContext } from "@/features/chat/messageLinks";

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

describe("MarkdownRenderer links", () => {
  it("links a standalone URL without relying on a Markdown marker", () => {
    const markup = renderToStaticMarkup(<MarkdownRenderer content="https://example.com/path" />);
    expect(markup).toContain('href="https://example.com/path"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it("routes explicit and bare Cheers locators without linking code blocks", () => {
    const markup = renderToStaticMarkup(
      <LocatorOpenContext.Provider value={vi.fn()}>
        <MarkdownRenderer content={'[plan](cheers:plan) cheers:desk/notes.md#L3\n\n```\ncheers:inbox/f-1\n```'} />
      </LocatorOpenContext.Provider>,
    );
    expect(markup).toContain('href="#workspace-ref-cheers%3Aplan"');
    expect(markup).toContain('href="#workspace-ref-cheers%3Adesk%2Fnotes.md%23L3"');
    expect(markup).not.toContain('href="#workspace-ref-cheers%3Ainbox%2Ff-1"');
  });

  it("does not activate unsafe schemes or unsupported message locators", () => {
    const markup = renderToStaticMarkup(
      <LocatorOpenContext.Provider value={vi.fn()}>
        <MarkdownRenderer content="[unsafe](javascript:alert%281%29) [message](cheers:msg/m-1)" />
      </LocatorOpenContext.Provider>,
    );
    expect(markup).not.toContain('href="javascript:');
    expect(markup).not.toContain('href="#workspace-ref-cheers%3Amsg');
  });
});
