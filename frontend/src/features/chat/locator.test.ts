import { describe, it, expect } from "vitest";
import { parseLocator } from "./locator";

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
