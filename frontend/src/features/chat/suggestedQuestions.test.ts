import { describe, expect, it } from "vitest";
import { firstUnresolvedSlot, parseSuggestedQuestions, SLOT_PATTERN } from "./suggestedQuestions";

describe("suggested questions", () => {
  it("accepts matched editable references", () => {
    const questions = parseSuggestedQuestions([{
      text: "Ask {{mention:who}} about {{file:target}} in {{panel:view}}",
      slots: [
        { key: "who", kind: "mention" },
        { key: "target", kind: "file" },
        { key: "view", kind: "panel" },
      ],
    }]);
    expect(questions).toHaveLength(1);
    expect(firstUnresolvedSlot(questions[0].text)?.[0]).toBe("{{mention:who}}");
    expect([...questions[0].text.matchAll(SLOT_PATTERN)]).toHaveLength(3);
  });

  it("rejects mismatched or duplicate references", () => {
    expect(parseSuggestedQuestions([{ text: "Read {{file:target}}", slots: [] }])).toEqual([]);
    expect(parseSuggestedQuestions([{ text: "Read {{file:target}}", slots: [{ key: "target", kind: "panel" }] }])).toEqual([]);
    expect(parseSuggestedQuestions([{ text: "Read {{file:target}}", slots: [{ key: "target", kind: "file" }, { key: "target", kind: "file" }] }])).toEqual([]);
  });
});
