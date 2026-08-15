import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConversationModePicker } from "./ConversationModePicker";

describe("ConversationModePicker", () => {
  it("uses two regular single-line choices", () => {
    const markup = renderToStaticMarkup(
      <ConversationModePicker value="chat" onChange={() => undefined} />,
    );
    expect(markup.match(/data-control-size="regular"/g)).toHaveLength(2);
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup.match(/data-button-content="iconText"/g)).toHaveLength(2);
    expect(markup).not.toContain('role="tablist"');
    expect(markup).toContain(">Chat<");
    expect(markup).toContain(">Discuss<");
    expect(markup).not.toContain("Chronological replies; your messages appear on the right.</span>");
  });
});
