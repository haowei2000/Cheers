import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { MessageItem } from "./MessageItem";
import { LocatorOpenContext } from "./messageLinks";

const source: Message = {
  msg_id: "source-message",
  sender_id: "user-1",
  sender_type: "user",
  sender_name: "System Administrator",
  content: "Please prepare the document and attach it here.",
};

const reply: Message = {
  msg_id: "reply-message",
  sender_id: "bot-1",
  sender_type: "bot",
  sender_name: "OpenCode",
  content: "I can prepare the document and attach it here.",
  reply_to_msg_id: source.msg_id,
};

describe("MessageItem reply preview", () => {
  it("keeps the replied-to identity and excerpt visible instead of an Open label", () => {
    const markup = renderToStaticMarkup(
      <MessageItem
        message={reply}
        repliedTo={source}
        nameOf={() => "System Administrator"}
      />,
    );

    expect(markup).toContain("@System Administrator");
    expect(markup).toContain("Please prepare the document");
    expect(markup).not.toContain(">Open<");
  });
});

describe("MessageItem suggested questions", () => {
  it("does not render suggested questions inline inside the message body", () => {
    const markup = renderToStaticMarkup(
      <MessageItem
        message={{ ...reply, content_data: { suggested_questions: [{
          text: "Ask {{mention:who}} to review {{file:target}}",
          slots: [{ key: "who", kind: "mention" }, { key: "target", kind: "file" }],
        }] } }}
        channelId="channel-1"
        actions={{ onReply: () => {}, onForward: () => {}, onToggleSelect: () => {}, onUseSuggestedQuestion: () => {} }}
      />,
    );
    expect(markup).not.toContain("Suggest more questions");
    expect(markup).not.toContain("Copy question into composer");
  });
});

describe("MessageItem identity anatomy", () => {
  it("renders a standalone Bot URL as a link after completion and plain text while streaming", () => {
    const final = renderToStaticMarkup(<MessageItem message={{ ...reply, content: "https://example.com" }} />);
    const streaming = renderToStaticMarkup(<MessageItem message={{ ...reply, content: "https://example.com", _streaming: true }} />);
    expect(final).toContain('href="https://example.com"');
    expect(streaming).not.toContain('href="https://example.com"');
  });

  it("shows a Bot's validated resource card with its fallback text", () => {
    const markup = renderToStaticMarkup(
      <LocatorOpenContext.Provider value={() => {}}>
        <MessageItem message={{ ...reply, content: "The plan is ready.", content_data: {
          cards: [{ v: 1, kind: "resource_ref", uri: "cheers:plan", title: "Plan" }],
        } }} />
      </LocatorOpenContext.Provider>,
    );
    expect(markup).toContain("The plan is ready.");
    expect(markup).toContain("Plan");
    expect(markup).toContain('href="#workspace-ref-cheers%3Aplan"');
  });

  it("does not crash while a realtime bot frame is missing identity metadata", () => {
    const incomplete = {
      msg_id: "early-stream-delta",
      sender_type: "bot",
      content: "Working",
      is_partial: true,
    } as Message;

    expect(renderToStaticMarkup(<MessageItem message={incomplete} />)).toContain(
      ">Bot</span>",
    );
  });

  it("renders the registered Stop action for an active bot turn", () => {
    const active = {
      ...reply,
      _streaming: true,
    } as Message;

    const markup = renderToStaticMarkup(
      <MessageItem message={active} channelId="channel-1" />,
    );

    expect(markup).toContain('aria-label="Stop response"');
    expect(markup).toContain('data-button-content="icon"');
  });

  it("keeps the 96px name rail in chat", () => {
    const markup = renderToStaticMarkup(<MessageItem message={source} />);

    expect(markup).toContain("w-24"); // identityRailWidthClasses.regular
    expect(markup).toContain(">System Administrator</span>");
  });

  it("renders the avatar alone in a discussion without losing attribution", () => {
    const markup = renderToStaticMarkup(
      <MessageItem message={source} identityLayout="avatar" />,
    );

    // The visible name and the rail it needed are both gone …
    expect(markup).not.toContain(">System Administrator</span>");
    expect(markup).not.toContain("w-24");
    // … but the sender is still announced and still shown on hover.
    expect(markup).toContain('aria-label="View profile for System Administrator"');
  });

  it("renders the standard channel ReplyPreview when replying to another reply in a sub-thread", () => {
    const subReply: Message = {
      msg_id: "sub-1",
      sender_id: "user-2",
      sender_type: "user",
      sender_name: "Alice",
      content: "I agree with this proposal.",
      reply_to_msg_id: source.msg_id,
    };

    const markup = renderToStaticMarkup(
      <MessageItem
        message={subReply}
        nested
        identityLayout="avatar"
        hideReplyQuote={false}
        repliedTo={source}
        nameOf={() => "System Administrator"}
      />,
    );

    expect(markup).toContain("@System Administrator");
    expect(markup).toContain("Please prepare the document and attach it here.");
  });
});

describe("MessageItem run overview", () => {
  const failedTool = { v: 1, id: "tool-failed", msg_id: reply.msg_id, trace_seq: 1, kind: "trace", phase: "tool_call", tool_call_id: "tool-1", status: "failed", is_terminal: true, created_at: "2026-10-29T00:00:00Z" };
  const finished = { ...failedTool, id: "finished", trace_seq: 2, phase: "prompt_finished", tool_call_id: undefined, status: "completed" };

  it("summarizes completion with tool errors without announcing a failed run", () => {
    const markup = renderToStaticMarkup(<MessageItem message={{ ...reply, trace_has_failure: true, _trace_events: [failedTool, finished] }} />);
    expect(markup).toContain("Completed · 1 tool · 1 tool failed");
    expect(markup).not.toContain("Agent step failed");
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('aria-haspopup="dialog"');
  });

  it("does not label a reloaded failure flag as an overall failure", () => {
    const markup = renderToStaticMarkup(<MessageItem message={{ ...reply, trace_count: 3, trace_has_failure: true }} />);
    expect(markup).toContain("Outcome unavailable · Step errors recorded");
    expect(markup).not.toContain("Run failed");
  });
});
