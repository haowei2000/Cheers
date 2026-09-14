import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationViewport } from "./ConversationViewport";

describe("ConversationViewport", () => {
  it("keeps a long message history inside shrinkable flex boundaries", () => {
    const markup = renderToStaticMarkup(
      <ConversationViewport conversationMode="chat">
        {Array.from({ length: 100 }, (_, index) => (
          <article key={index}>Message {index + 1}</article>
        ))}
      </ConversationViewport>,
    );

    expect(markup).toContain(
      'data-channel-conversation="" class="flex min-h-0 min-w-0 flex-1 flex-col"',
    );
    expect(markup).toContain(
      'data-message-scroll-boundary="" class="flex h-full min-h-0 w-full min-w-0 flex-col md:mx-auto md:max-w-[52rem]"',
    );
    expect(markup.match(/<article>/g)).toHaveLength(100);
  });
});
