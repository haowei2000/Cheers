import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UnreadBadge } from "./unread-badge";

describe("UnreadBadge", () => {
  it.each([
    ["small", "min-h-3.5"],
    ["regular", "min-h-4"],
    ["large", "min-h-5"],
  ] as const)("uses the registered %s content size", (contentSize, sizeClass) => {
    const markup = renderToStaticMarkup(
      <UnreadBadge contentSize={contentSize}>3</UnreadBadge>
    );

    expect(markup).toContain(sizeClass);
    expect(markup).toContain('data-design-system-exempt="unread"');
  });

  it("uses the mention state color without creating a local badge recipe", () => {
    const markup = renderToStaticMarkup(
      <UnreadBadge tone="mention">@2</UnreadBadge>
    );

    expect(markup).toContain("bg-rose-600");
    expect(markup).toContain("rounded-full");
  });
});
