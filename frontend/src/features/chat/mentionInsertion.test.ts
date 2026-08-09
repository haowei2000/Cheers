import { describe, expect, it } from "vitest";
import { appendMentionToken } from "./mentionInsertion";

describe("appendMentionToken", () => {
  it("adds a mention to an empty draft", () => {
    expect(appendMentionToken("", "Alice")).toBe("@Alice ");
  });

  it("preserves typed text and inserts one separating space", () => {
    expect(appendMentionToken("Can you review this?", "AI Team Bot")).toBe(
      "Can you review this? @AI Team Bot ",
    );
  });

  it("does not duplicate an existing standalone mention", () => {
    expect(appendMentionToken("Hi @Alice, please check", "Alice")).toBe(
      "Hi @Alice, please check",
    );
  });

  it("does not mistake a longer mention for the requested token", () => {
    expect(appendMentionToken("Hi @AliceBot", "Alice")).toBe(
      "Hi @AliceBot @Alice ",
    );
  });
});
