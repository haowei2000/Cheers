import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CanvasLens } from "./CanvasLens";

describe("CanvasLens accessibility", () => {
  it("exposes focusable nodes and visible non-drag actions", () => {
    const html = renderToStaticMarkup(
      <CanvasLens
        data={{
          canvas: 1,
          nodes: [
            { id: "notes", text: "Notes" },
            { id: "plan", source: { kind: "fs", path: "plan.md" } },
          ],
          edges: [],
        }}
        config={undefined}
        onChange={() => {}}
        onOps={() => {}}
        openLocator={() => {}}
      />
    );
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html.match(/tabindex="0"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Use arrow keys to move focus between nodes");
    expect(html).toContain('aria-label="Connect selected node"');
    expect(html).toContain('aria-label="Open selected source in Workbench"');
    expect(html).toContain('aria-label="Fit canvas"');
  });
});
