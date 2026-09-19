import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Separator } from "./separator";

describe("Separator", () => {
  it("keeps a purely visual rule out of the accessibility tree", () => {
    const html = renderToStaticMarkup(<Separator />);
    expect(html).toContain('role="presentation"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("aria-orientation");
    expect(html).toContain("h-px");
  });

  it("announces a meaningful rule with its orientation", () => {
    const html = renderToStaticMarkup(<Separator orientation="vertical" decorative={false} />);
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).toContain("w-px");
  });

  it("draws with a background so it never shifts layout", () => {
    const html = renderToStaticMarkup(<Separator />);
    expect(html).toContain("bg-zinc-800");
    expect(html).not.toMatch(/class="[^"]*\bborder\b/);
  });
});
