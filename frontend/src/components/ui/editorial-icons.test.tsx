import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EditorialIcon, editorialIconNames } from "@/components/ui/editorial-icons";

describe("EditorialIcon", () => {
  it("renders every registered semantic icon on the shared 24 grid", () => {
    for (const name of editorialIconNames) {
      const markup = renderToStaticMarkup(<EditorialIcon name={name} />);
      expect(markup).toContain('viewBox="0 0 24 24"');
      expect(markup).toContain('stroke-width="1.75"');
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it("exposes a title when the icon carries standalone meaning", () => {
    const markup = renderToStaticMarkup(
      <EditorialIcon name="correspondence" title="Correspondence" />
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain("<title>Correspondence</title>");
    expect(markup).not.toContain('aria-hidden="true"');
  });
});
