import { describe, it, expect } from "vitest";
import corpus from "../../../../fixtures/locator/corpus.json";
import { formatLocator, parseLocator } from "./locator";

describe("parseLocator", () => {
  it("parses a ws locator with a line range", () => {
    expect(parseLocator("cheers:ws/@backend/server/src/resource/fs.rs#L564-L600")).toEqual({
      kind: "ws",
      bot: "@backend",
      path: "server/src/resource/fs.rs",
      line: 564,
      lineEnd: 600,
    });
  });

  it("parses a ws locator with a single line and a bot id", () => {
    expect(parseLocator("cheers:ws/8b1f2c3d/src/main.rs#L1")).toEqual({
      kind: "ws",
      bot: "8b1f2c3d",
      path: "src/main.rs",
      line: 1,
    });
  });

  it("parses a ws locator without an anchor", () => {
    expect(parseLocator("cheers:ws/@dev/frontend/src/App.tsx")).toEqual({
      kind: "ws",
      bot: "@dev",
      path: "frontend/src/App.tsx",
    });
  });

  it("parses desk / msg / inbox locators", () => {
    expect(parseLocator("cheers:desk/codemap/map.yaml#L12")).toEqual({
      kind: "desk",
      path: "codemap/map.yaml",
      line: 12,
    });
    expect(parseLocator("cheers:msg/0af3c2")).toEqual({ kind: "msg", messageId: "0af3c2" });
    expect(parseLocator("cheers:inbox/6f2a-11")).toEqual({ kind: "inbox", fileId: "6f2a-11" });
  });

  it("swaps a reversed line range instead of rejecting it", () => {
    expect(parseLocator("cheers:desk/a.md#L30-L10")).toEqual({
      kind: "desk",
      path: "a.md",
      line: 10,
      lineEnd: 30,
    });
  });

  it("rejects non-locators and malformed shapes", () => {
    expect(parseLocator("https://example.com")).toBeNull();
    expect(parseLocator("cheers:")).toBeNull();
    expect(parseLocator("cheers:desk/")).toBeNull();
    expect(parseLocator("cheers:ws/@bot")).toBeNull(); // no path
    expect(parseLocator("cheers:ws/@/x.rs")).toBeNull(); // empty handle
    expect(parseLocator("cheers:nope/x")).toBeNull(); // unknown sub-scheme
    expect(parseLocator("cheers:msg/a/b")).toBeNull(); // ids have no slashes
    expect(parseLocator("cheers:msg/a#L3")).toBeNull(); // anchors are for files
  });

  it("rejects whitespace, traversal and absolute paths", () => {
    expect(parseLocator("cheers:desk/a b.md")).toBeNull();
    expect(parseLocator("cheers:desk/../etc/passwd")).toBeNull();
    expect(parseLocator("cheers:desk//etc/passwd")).toBeNull();
    expect(parseLocator("cheers:ws/@bot/a/./b.rs")).toBeNull();
    expect(parseLocator("cheers:ws/@bot/a\\b.rs")).toBeNull();
  });

  it("rejects malformed fragments loudly (not silently ignoring them)", () => {
    expect(parseLocator("cheers:desk/a.md#l3")).toBeNull();
    expect(parseLocator("cheers:desk/a.md#L0")).toBeNull();
    expect(parseLocator("cheers:desk/a.md#section")).toBeNull();
  });
});

// ── the shared grammar ───────────────────────────────────────────────────────
// The `cheers:` grammar is parsed twice — here and in Rust by
// packages/cheers-mcp-server/src/locator.rs — because agents write locators into text
// the Gateway reads, and users click locators the browser resolves. Neither side can
// delegate to the other, and two hand-written parsers of one format drift.
//
// Both sides assert against fixtures/locator/corpus.json, so a rule changed on one side
// fails the other side's build. Same reason fixtures/workbench exists for the extension
// grammar. This file does not re-check resolution: only the Gateway resolves.

describe("the shared locator corpus", () => {
  it("has cases to run", () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  it.each(corpus.cases)("$uri — $why", ({ uri, parses }) => {
    const parsed = parseLocator(uri);
    if (parses) {
      expect(parsed, `${uri} should parse`).not.toBeNull();
      // Rendering must produce a locator that reads back identically. NOT equality with
      // the input: parsing is deliberately tolerant, so `#L9-L3` canonicalizes to
      // `#L3-L9`. What must hold is that the canonical form is stable — otherwise
      // "copy link" could emit something that parses to a different resource.
      const rendered = formatLocator(parsed!);
      expect(parseLocator(rendered), `${rendered} should read back the same`).toEqual(parsed);
    } else {
      expect(parsed, `${uri} must not parse`).toBeNull();
    }
  });
});
