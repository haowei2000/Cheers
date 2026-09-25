import { describe, expect, it } from "vitest";
import {
  findActiveBotSuggestions,
  firstUnresolvedSlot,
  formatSuggestionDisplayText,
  parseSuggestedQuestions,
  SLOT_PATTERN,
} from "./suggestedQuestions";

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

  it("accepts file paths, hyphens, slot alias, and outer suggestions object", () => {
    const questions = parseSuggestedQuestions({
      suggestions: [{
        text: "给 {{file:samples/codemap-canvas.html}} 加上点击节点查看详情的功能",
        slot: [{ key: "samples/codemap-canvas.html", kind: "file" }],
      }],
    });
    expect(questions).toHaveLength(1);
    expect(questions[0].slots[0].key).toBe("samples/codemap-canvas.html");
  });

  it("formats suggestion display text with bracketed markers", () => {
    expect(
      formatSuggestionDisplayText("Ask {{mention:dev-bot}} about {{file:src/main.rs}} and {{panel:workbench}}")
    ).toBe("Ask [mention] about [file] and [panel]");
  });

  describe("findActiveBotSuggestions", () => {
    const userPrompt = {
      msg_id: "m-user-1",
      sender_id: "user-123",
      sender_type: "user",
      content: "Explain the project",
    };
    const botResponse = {
      msg_id: "m-bot-1",
      sender_id: "bot-dev",
      sender_type: "bot",
      reply_to_msg_id: "m-user-1",
      content: "Here is the explanation.",
      content_data: {
        suggested_questions: [
          { text: "How do I run tests?", slots: [] },
          { text: "Where is {{file:README.md}}?", slots: [{ key: "README.md", kind: "file" }] },
        ],
      },
    };

    it("identifies active suggestions triggered by current user via reply_to_msg_id", () => {
      const active = findActiveBotSuggestions({
        messages: [userPrompt, botResponse],
        currentUserId: "user-123",
      });
      expect(active).not.toBeNull();
      expect(active?.msgId).toBe("m-bot-1");
      expect(active?.questions).toHaveLength(2);
    });

    it("identifies active suggestions triggered by current user via preceding user message", () => {
      const botResponseWithoutReplyId = {
        ...botResponse,
        reply_to_msg_id: null,
      };
      const active = findActiveBotSuggestions({
        messages: [userPrompt, botResponseWithoutReplyId],
        currentUserId: "user-123",
      });
      expect(active?.msgId).toBe("m-bot-1");
    });

    it("returns null if triggered by a different user", () => {
      const active = findActiveBotSuggestions({
        messages: [userPrompt, botResponse],
        currentUserId: "user-other",
      });
      expect(active).toBeNull();
    });

    it("returns null if bot message is currently streaming", () => {
      const active = findActiveBotSuggestions({
        messages: [userPrompt, { ...botResponse, is_partial: true }],
        currentUserId: "user-123",
        streamingIds: ["m-bot-1"],
      });
      expect(active).toBeNull();
    });

    it("returns null if current user has already replied after the bot response", () => {
      const followUp = {
        msg_id: "m-user-2",
        sender_id: "user-123",
        sender_type: "user",
        content: "Thanks!",
      };
      const active = findActiveBotSuggestions({
        messages: [userPrompt, botResponse, followUp],
        currentUserId: "user-123",
      });
      expect(active).toBeNull();
    });

    it("returns null if the latest bot message has no suggestions", () => {
      const botNoSuggestions = {
        msg_id: "m-bot-2",
        sender_id: "bot-dev",
        sender_type: "bot",
        reply_to_msg_id: "m-user-2",
        content: "OK.",
      };
      const active = findActiveBotSuggestions({
        messages: [userPrompt, botResponse, { msg_id: "m-user-2", sender_id: "user-123", sender_type: "user" }, botNoSuggestions],
        currentUserId: "user-123",
      });
      expect(active).toBeNull();
    });

    it("identifies suggestions when active bot turn produced multiple bot messages (e.g. post_message and task bubble)", () => {
      const taskSummaryBubble = {
        msg_id: "m-bot-task-done",
        sender_id: "bot-dev",
        sender_type: "bot",
        content: "Done task",
        content_data: {},
      };
      const active = findActiveBotSuggestions({
        messages: [userPrompt, botResponse, taskSummaryBubble],
        currentUserId: "user-123",
      });
      expect(active).not.toBeNull();
      expect(active?.msgId).toBe("m-bot-1");
      expect(active?.questions).toHaveLength(2);
    });
  });
});
