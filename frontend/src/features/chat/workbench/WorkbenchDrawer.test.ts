import { describe, expect, it } from "vitest";
import { parseCfg } from "./WorkbenchDrawer";
import { reconcileSceneItems, sceneTabContextActions } from "./SceneWorkbench";

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
        views: [
          { id: "plan", title: "Plan", file: "dev/plan.yaml", lens: "kanban" },
          { id: "codemap", title: "Codemap", file: "codemap/map.yaml", lens: "codemap" },
        ],
      }],
      null
    );

    expect(state.order).toEqual(["cheers-code-project", "custom"]);
    expect(state.items["cheers-code-project"]).toEqual(["dev/plan.yaml", "codemap/map.yaml"]);
    expect(state.items.custom).toEqual(["custom/view.md"]);
  });
});

describe("scene context actions", () => {
  it("switches from a scene to Raw through the shared drawer callback", () => {
    let selected = false;
    let raw = false;
    const actions = sceneTabContextActions(
      "Research lab",
      () => { selected = true; },
      () => { raw = true; },
      () => undefined,
    );

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "open-scene", label: "Open Research lab" },
      { id: "add-context", label: "Add scene to context" },
      { id: "raw", label: "Raw" },
    ]);
    actions.find((action) => action.id === "raw")?.run();
    expect(raw).toBe(true);
    expect(selected).toBe(false);
  });

  it("disables context attachment for a scene with no files", () => {
    const action = sceneTabContextActions(
      "Other",
      () => undefined,
      () => undefined,
      () => undefined,
      false,
      false,
    ).find((candidate) => candidate.id === "add-context");

    expect(action).toMatchObject({ label: "No scene files to add", disabled: true });
  });
});
