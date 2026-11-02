import { describe, expect, it } from "vitest";
import { appendMentionToken, createMentionContinuation, hasComposerBody, hasMentionToken, pickedMentionsInText } from "./mentionInsertion";

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

describe("mention continuation", () => {
  const bot = { id: "bot-1", label: "Ada", type: "bot" as const };
  const person = { id: "user-1", label: "Ann", type: "user" as const };
  const group = { id: "all", label: "all", type: "group" as const };

  it("retains individual recipients once using their current identity labels", () => {
    expect(createMentionContinuation([bot, person, bot], [{ ...bot, label: "Ada Bot" }, person])).toEqual({
      text: "@Ada Bot @Ann ", picked: [{ ...bot, label: "Ada Bot" }, person],
    });
  });

  it("does not carry broadcasts, departed members, or fixed session targets forward", () => {
    expect(createMentionContinuation([bot, person, group], [person, group]).text).toBe("@Ann ");
    expect(createMentionContinuation([bot], [bot], true)).toEqual({ text: "", picked: [] });
  });

  it("treats recipients alone as empty while preserving real message text", () => {
    expect(hasComposerBody("@Ada @Ann ", ["Ada", "Ann"])).toBe(false);
    expect(hasComposerBody("@Ada Bot ", ["Ada", "Ada Bot"])).toBe(false);
    expect(hasComposerBody("@Ada review this", ["Ada"])).toBe(true);
    expect(hasComposerBody("@Anna hello", ["Ann"])).toBe(true);
  });

  it("matches full tokens instead of routing label prefixes", () => {
    expect(hasMentionToken("@Anna hello", "Ann")).toBe(false);
    expect(hasMentionToken("@Ann, hello", "Ann")).toBe(true);
    expect(hasMentionToken("@Ada Bot hello", "Ada Bot")).toBe(true);
    const longer = { id: "bot-2", label: "Ada Bot", type: "bot" as const };
    expect(pickedMentionsInText("@Ada Bot hello", [bot, longer])).toEqual([longer]);
    expect(pickedMentionsInText("@Ada @Ada Bot hello", [bot, longer])).toEqual([bot, longer]);
    const sameName = { ...bot, id: "bot-3" };
    expect(pickedMentionsInText("@Ada hello", [bot, sameName, bot])).toEqual([bot, sameName]);
  });
});
