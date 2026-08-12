import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/types";
import { MessageItem } from "./MessageItem";

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
