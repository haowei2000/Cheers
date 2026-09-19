import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SkipLink } from "./skip-link";

describe("SkipLink", () => {
  it("points at the target region and stays hidden until it is focused", () => {
    const html = renderToStaticMarkup(<SkipLink targetId="message-list" />);
    expect(html).toContain('href="#message-list"');
    expect(html).toContain("Skip to content");
    // Hidden by clipping, not display:none — it has to stay focusable.
    expect(html).toContain("sr-only");
    expect(html).toContain("focus-visible:not-sr-only");
  });

  it("accepts its own label", () => {
    const html = renderToStaticMarkup(<SkipLink targetId="composer">Skip to the composer</SkipLink>);
    expect(html).toContain("Skip to the composer");
    expect(html).not.toContain("Skip to content");
  });
});
