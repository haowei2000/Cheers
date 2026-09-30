import { describe, expect, it } from "vitest";
import {
  canAddTabToCollection,
  reconcileSceneItems,
  sceneTabContextActions,
  unclaimedRenderableTabs,
} from "./SceneWorkbench";

describe("SceneWorkbench tab and collection logic", () => {
  it("determines if tabs can be added to collections", () => {
    const state = {
      version: 1 as const,
      order: ["dev-collection", "docs-collection"],
      titles: { "dev-collection": "Dev", "docs-collection": "Docs" },
      items: { "dev-collection": ["main.rs"], "docs-collection": ["readme.md"] },
    };

    expect(canAddTabToCollection(state, "dev-collection")).toBe(true);
    expect(canAddTabToCollection(state, "__other__")).toBe(false);
    expect(canAddTabToCollection(state, "canvas:board.canvas.yaml")).toBe(false);
    expect(canAddTabToCollection(state, "non-existent")).toBe(false);
  });

  it("filters unclaimed renderable tabs correctly", () => {
    const state = {
      version: 1 as const,
      order: ["dev"],
      titles: { dev: "Dev" },
      items: { dev: ["src/lib.rs"] },
    };

    const files = ["src/lib.rs", "src/main.rs", "design.canvas.yaml", "notes.md"];
    const unclaimed = unclaimedRenderableTabs(files, state);

    // Should include files not in state.items, excluding canvas files
    expect(unclaimed).toEqual(["notes.md", "src/main.rs"]);
  });

  it("reconciles scene items with official templates", () => {
    const state = reconcileSceneItems(
      {
        version: 1,
        order: ["code"],
        titles: { code: "Code" },
        items: { code: ["src/lib.rs"] },
      },
      [
        {
          id: "code",
          title: "Code",
          items: [
            { id: "lib", title: "Lib", source: { kind: "fs", path: "src/lib.rs" } },
            { id: "main", title: "Main", source: { kind: "fs", path: "src/main.rs" } },
          ],
        },
      ],
      null,
    );

    expect(state.items.code).toEqual(["src/lib.rs", "src/main.rs"]);
  });

  it("generates correct context menu actions for collection tabs", () => {
    let rawOpened = false;
    let selected = false;
    const actions = sceneTabContextActions(
      "Dev",
      () => { selected = true; },
      () => { rawOpened = true; },
      () => {},
      true,
      true,
    );

    const ids = actions.map((a) => a.id);
    expect(ids).toContain("open-collection");
    expect(ids).toContain("add-context");
    expect(ids).toContain("raw");

    actions.find((a) => a.id === "raw")?.run();
    expect(rawOpened).toBe(true);
    expect(selected).toBe(false);
  });
});
