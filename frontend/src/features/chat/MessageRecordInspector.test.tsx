import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { MessageRecordInspector } from "./MessageRecordInspector";

const testMessage: Message = {
  msg_id: "msg-12345678",
  sender_id: "bot-1",
  sender_type: "bot",
  sender_name: "Cheers Bot",
  content: "Test message",
  created_at: "2026-09-17T15:00:00Z",
};

describe("MessageRecordInspector", () => {
  it("keeps the header with close button pinned while body is scrollable and draggable", () => {
    const triggerRef = createRef<HTMLElement>();
    const markup = renderToStaticMarkup(
      <MessageRecordInspector
        message={testMessage}
        channelId="ch-1"
        meta={{
          hasDetails: true,
          contextCount: 2,
          traceCount: 5,
          hasTrace: true,
          hasFailure: false,
        }}
        triggerRef={triggerRef}
        onClose={() => undefined}
      />,
    );

    // Shell is flex flex-col overflow-hidden
    expect(markup).toContain("flex flex-col overflow-hidden");

    // Header has shrink-0, is draggable with cursor-grab, and contains close button
    expect(markup).toContain("shrink-0 px-5 pt-3 md:px-6 md:pt-4");
    expect(markup).toContain("cursor-grab");
    expect(markup).toContain('aria-label="Close message record"');
    expect(markup).toContain("Test message");

    // Body has min-h-0 flex-1 overflow-y-auto overscroll-contain
    expect(markup).toContain("min-h-0 flex-1 overflow-y-auto overscroll-contain");
  });

  it("displays message content as the core header and omits redundant top metadata", () => {
    const triggerRef = createRef<HTMLElement>();
    const markup = renderToStaticMarkup(
      <MessageRecordInspector
        message={testMessage}
        channelId="ch-1"
        meta={{
          hasDetails: true,
          contextCount: 0,
          traceCount: 3,
          hasTrace: true,
          hasFailure: true,
        }}
        triggerRef={triggerRef}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain("Test message");
    expect(markup).not.toContain("Message record ·");
    expect(markup).not.toContain("One or more agent steps failed.");
  });
});
