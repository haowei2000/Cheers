import { describe, expect, it } from "vitest";
import { appendCollectionTab, parseCfg } from "./WorkbenchDrawer";
import { canAddTabToCollection, reconcileSceneItems, sceneTabContextActions, unclaimedRenderableTabs } from "./SceneWorkbench";

describe("workbench scene config", () => {
  it("preserves native multi-scene navigation state", () => {
    const config = parseCfg(JSON.stringify({
      environment: "cheers-code-project",
      bindings: { "dev/plan.yaml": "builtin:kanban" },
      scene_state: {
        version: 1,
        order: ["cheers-code-project", "cheers-research-lab"],
        titles: {
          "cheers-code-project": "Code project",
          "cheers-research-lab": "Research lab",
        },
        items: {
          "cheers-code-project": ["dev/plan.yaml"],
          "cheers-research-lab": ["lab/experiments.yaml"],
        },
      },
    }));

    expect(config.scene_state?.order).toEqual([
      "cheers-code-project",
      "cheers-research-lab",
    ]);
    expect(config.scene_state?.items["cheers-code-project"]).toEqual(["dev/plan.yaml"]);
  });
});

describe("appendCollectionTab", () => {
  it("appends a Tab while preserving the latest Collection state", () => {
    const state = {
      version: 1 as const,
      order: ["project", "research"],
      titles: { project: "Project", research: "Research" },
      items: { project: ["plan.md"], research: ["paper.md"] },
    };
    expect(appendCollectionTab(state, "project", "notes.md")).toEqual({
      ...state,
      items: { project: ["plan.md", "notes.md"], research: ["paper.md"] },
    });
  });

  it("does not duplicate a Tab", () => {
    const state = { version: 1 as const, order: ["project"], titles: {}, items: { project: ["plan.md"] } };
    expect(appendCollectionTab(state, "project", "plan.md")).toBe(state);
  });

  it("removes an added file from the derived Other Collection", () => {
    const state = { version: 1 as const, order: ["project"], titles: {}, items: { project: ["plan.md"] } };
    expect(unclaimedRenderableTabs(["plan.md", "notes.md"], state)).toEqual(["notes.md"]);
    const next = appendCollectionTab(state, "project", "notes.md");
    expect(unclaimedRenderableTabs(["plan.md", "notes.md"], next)).toEqual([]);
  });

  it("allows adding Tabs only to persisted Collections", () => {
    const state = { version: 1 as const, order: ["project"], titles: {}, items: { project: [] } };
    expect(canAddTabToCollection(state, "project")).toBe(true);
    expect(canAddTabToCollection(state, "__other__")).toBe(false);
    expect(canAddTabToCollection(state, "canvas:board.canvas.json")).toBe(false);
  });
});

describe("reconcileSceneItems", () => {
  it("adds new official tabs without replacing shared scene order", () => {
    const state = reconcileSceneItems(
      {
        version: 1,
        order: ["cheers-code-project", "custom"],
        titles: { "cheers-code-project": "Code project", custom: "Custom" },
        items: { "cheers-code-project": ["dev/plan.yaml"], custom: ["custom/view.md"] },
      },
      [{
        id: "cheers-code-project",
        title: "Code project",
        items: [
          { id: "plan", title: "Plan", source: { kind: "fs", path: "dev/plan.yaml" }, view: "builtin:kanban" },
          { id: "codemap", title: "Codemap", source: { kind: "fs", path: "codemap/map.yaml" }, view: "builtin:codemap" },
        ],
      }],
      null
    );

    expect(state.order).toEqual(["cheers-code-project", "custom"]);
    expect(state.items["cheers-code-project"]).toEqual(["dev/plan.yaml", "codemap/map.yaml"]);
    expect(state.items.custom).toEqual(["custom/view.md"]);
  });
});

describe("Collection context actions", () => {
  it("switches from a Collection to Raw through the shared drawer callback", () => {
    let selected = false;
    let raw = false;
    const actions = sceneTabContextActions(
      "Research lab",
      () => { selected = true; },
      () => { raw = true; },
      () => undefined,
    );

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "open-collection", label: "Open Research lab" },
      { id: "add-context", label: "Add Collection to context" },
      { id: "raw", label: "Raw" },
    ]);
    actions.find((action) => action.id === "raw")?.run();
    expect(raw).toBe(true);
    expect(selected).toBe(false);
  });

  it("disables context attachment for a Collection with no files", () => {
    const action = sceneTabContextActions(
      "Other",
      () => undefined,
      () => undefined,
      () => undefined,
      false,
      false,
    ).find((candidate) => candidate.id === "add-context");

    expect(action).toMatchObject({ label: "No Collection files to add", disabled: true });
  });
});
