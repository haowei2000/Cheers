import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("stays out of the accessibility tree", () => {
    const html = renderToStaticMarkup(<Skeleton />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pulse");
  });

  it("ends a multi-line block on a short line, the way a paragraph does", () => {
    const html = renderToStaticMarkup(<Skeleton lines={3} />);
    expect(html.match(/animate-pulse/g)).toHaveLength(3);
    expect(html.match(/w-3\/5/g)).toHaveLength(1);
    expect(html.match(/w-full/g)).toHaveLength(2);
  });

  it("borrows the shared radius rather than registering a round one", () => {
    const html = renderToStaticMarkup(<Skeleton shape="circle" />);
    expect(html).toContain("rounded-sm");
    expect(html).not.toContain("rounded-full");
  });
});
