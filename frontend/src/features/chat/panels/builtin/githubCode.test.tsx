import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { panelsFor } from "../registry";
import "./githubCode";

describe("githubCode panels", () => {
  const mockContext = {
    channelId: "test-channel",
    profile: {
      profile: "code",
      config: {},
      status: { state: "pending" as const },
    },
  };

  it("renders CodeHeader as an interactive trigger with repo, branch, and status", () => {
    const headerPanel = panelsFor("header", "code").find(
      (p) => p.id === "official.github-code.header",
    );
    expect(headerPanel).toBeDefined();

    const Header = headerPanel!.render;
    const markup = renderToStaticMarkup(React.createElement(Header, mockContext));

    expect(markup).toContain('data-control-trigger=""');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("Local repository");
    expect(markup).toContain("local");
    expect(markup).toContain("pending");
    expect(markup).toContain("Configure repository &amp; execution target");
  });

  it("renders CodeBoard with repository switch button and host execution target button", () => {
    const boardPanel = panelsFor("lane", "code").find(
      (p) => p.id === "github-code",
    );
    expect(boardPanel).toBeDefined();

    const Board = boardPanel!.render;
    const markup = renderToStaticMarkup(React.createElement(Board, mockContext));

    expect(markup).toContain("Repository &amp; Working directory");
    expect(markup).toContain("Local repository");
    expect(markup).toContain("Host execution target");
    expect(markup).toContain('title="Configure repository and working directory"');
    expect(markup).toContain('title="Configure execution target"');
  });
});
