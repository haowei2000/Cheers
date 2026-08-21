import { describe, expect, it } from "vitest";
import { sourcePathLineRange, uniqueSourceTextRange } from "./contextSource";

describe("uniqueSourceTextRange", () => {
  it("maps a unique multiline anchor and normalizes CRLF", () => {
    expect(uniqueSourceTextRange("a\r\nb\r\nc\r\n", "b\nc")).toEqual({ start: 2, end: 3 });
  });

  it("rejects missing, duplicate, and overlapping anchors", () => {
    expect(uniqueSourceTextRange("abc", "x")).toBeNull();
    expect(uniqueSourceTextRange("x\nx", "x")).toBeNull();
    expect(uniqueSourceTextRange("aaa", "aa")).toBeNull();
  });
});

describe("sourcePathLineRange", () => {
  it("maps YAML and JSON array rows", () => {
    expect(sourcePathLineRange("- run: baseline\n  status: queued\n- run: next\n", [0]))
      .toEqual({ start: 1, end: 2 });
    expect(sourcePathLineRange('[\n  { "run": "baseline" },\n  { "run": "next" }\n]', [1]))
      .toEqual({ start: 3, end: 3 });
  });

  it("maps nested card values", () => {
    const yaml = "columns:\n  - name: Todo\n    items:\n      - first\n      - second\n";
    expect(sourcePathLineRange(yaml, ["columns", 0, "items", 1])).toEqual({ start: 5, end: 5 });
  });
});
