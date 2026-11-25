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

  it("renders declarative data-cheers-locator on source nodes", () => {
    const html = renderToStaticMarkup(
      <CanvasLens
        data={{
          canvas: 1,
          nodes: [
            { id: "src-node", source: { kind: "fs", path: "src/main.rs" } },
          ],
          edges: [],
        }}
        config={undefined}
        onChange={() => {}}
        onOps={() => {}}
        openLocator={() => {}}
      />
    );
    expect(html).toContain('data-cheers-locator="cheers:desk/src/main.rs"');
    expect(html).toContain('data-cheers-label="main.rs"');
  });

  it("links an artifact node by its stable id, not a path", () => {
    const id = "0f8b6c2e-4d3a-4b1c-9e7f-2a5d8c1b3e60";
    const html = renderToStaticMarkup(
      <CanvasLens
        data={{ canvas: 1, nodes: [{ id: "plan", source: { kind: "artifact", id } }], edges: [] }}
        config={undefined}
        onChange={() => {}}
        onOps={() => {}}
        openLocator={() => {}}
      />
    );
    expect(html).toContain(`data-cheers-locator="cheers:artifact/${id}"`);
  });
});
