import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReplyComposerBanner } from "./ReplyComposerBanner";

const message = { msg_id: "source", sender_id: "ada", sender_type: "bot" as const, content: "The full original message", sender_name: "Ada" };

describe("ReplyComposerBanner", () => {
  it("shows the selection instead of repeating the original message", () => {
    const markup = renderToStaticMarkup(<ReplyComposerBanner message={message} quote={"Selected line\nAnother line"} onCancel={vi.fn()} />);
    expect(markup).toContain("Selected line\nAnother line</blockquote>");
    expect(markup).not.toContain(message.content);
    expect(markup).toContain('aria-label="Cancel reply"');
    expect(markup).toContain('aria-label="Replying to Ada"');
  });

  it("keeps the original excerpt for ordinary replies", () => {
    const markup = renderToStaticMarkup(<ReplyComposerBanner message={message} onCancel={vi.fn()} />);
    expect(markup).toContain(message.content);
    expect(markup).not.toContain("<blockquote");
  });
});
