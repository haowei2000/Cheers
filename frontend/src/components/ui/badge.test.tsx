import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders a compact semantic status with a redundant indicator", () => {
    const markup = renderToStaticMarkup(<Badge tone="success" indicator>Healthy</Badge>);
    expect(markup).toContain('data-badge-tone="success"');
    expect(markup).toContain("text-success-300");
    expect(markup).toContain("bg-current");
    expect(markup).toContain(">Healthy<");
  });

  it("keeps disabled state explicit", () => {
    const markup = renderToStaticMarkup(<Badge disabled>Unavailable</Badge>);
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("opacity-50");
  });
});
