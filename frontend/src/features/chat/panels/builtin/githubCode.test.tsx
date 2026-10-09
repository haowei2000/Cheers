import React, { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { panelsFor, type PanelSurface } from "../registry";
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

describe("GitHub code panel component boundaries", () => {
  it.each(["header", "lane", "inline"] as PanelSurface[])(
    "%s factory can run outside React without executing component hooks",
    (surface) => {
      const panel = panelsFor(surface, "code").find((entry) =>
        entry.id === "github-code" || entry.id.startsWith("official.github"),
      );
      expect(panel).toBeDefined();
      // Hosts call the factory conditionally when the channel profile changes.
      // Calling a hook-using component here would throw an invalid hook call.
      const element = panel!.render({ channelId: "test-channel", profile: null });
      expect(isValidElement(element)).toBe(true);
      expect(renderToStaticMarkup(<>{element}</>)).toBe("");
    },
  );
});
