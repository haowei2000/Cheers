import { beforeEach, describe, expect, it } from "vitest";
import {
  panelsFor,
  registerPanel,
  resetPanelsForTest,
  type PanelSurface,
} from "./registry";

// The three registries this one replaced each had their own profile-filtering rule.
// They agreed, but only by coincidence of being written the same way three times —
// these cases freeze the shared behavior so a future edit cannot quietly change one
// surface's visibility without changing all of them.

function panel(id: string, surface: PanelSurface, profiles?: string[]) {
  return { id, title: id, surface, profiles, render: () => null };
}

beforeEach(() => resetPanelsForTest());

describe("registerPanel", () => {
  it("ignores a duplicate id so an import cycle cannot double-register", () => {
    registerPanel(panel("plan", "lane"));
    registerPanel({ ...panel("plan", "lane"), title: "Impostor" });

    const found = panelsFor("lane");
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe("plan");
  });

  it("keeps registration order", () => {
    registerPanel(panel("plan", "lane"));
    registerPanel(panel("cost", "lane"));
    registerPanel(panel("sessions", "lane"));

    expect(panelsFor("lane").map((p) => p.id)).toEqual(["plan", "cost", "sessions"]);
  });
});

describe("panelsFor", () => {
  it("separates surfaces — one id per surface is three distinct panels", () => {
    registerPanel(panel("code-header", "header", ["code"]));
    registerPanel(panel("code-lane", "lane", ["code"]));
    registerPanel(panel("code-inline", "inline", ["code"]));

    expect(panelsFor("header", "code").map((p) => p.id)).toEqual(["code-header"]);
    expect(panelsFor("lane", "code").map((p) => p.id)).toEqual(["code-lane"]);
    expect(panelsFor("inline", "code").map((p) => p.id)).toEqual(["code-inline"]);
  });

  it("includes an unprofiled panel in every channel, profiled or not", () => {
    registerPanel(panel("plan", "lane"));

    expect(panelsFor("lane", "code").map((p) => p.id)).toEqual(["plan"]);
    expect(panelsFor("lane", null).map((p) => p.id)).toEqual(["plan"]);
    expect(panelsFor("lane").map((p) => p.id)).toEqual(["plan"]);
  });

  it("hides a profiled panel from channels without that profile", () => {
    registerPanel(panel("github-code", "lane", ["code"]));

    expect(panelsFor("lane", "code").map((p) => p.id)).toEqual(["github-code"]);
    expect(panelsFor("lane", "research")).toEqual([]);
    // The critical case: an unprofiled channel must NOT inherit profiled panels.
    expect(panelsFor("lane", null)).toEqual([]);
    expect(panelsFor("lane")).toEqual([]);
  });

  it("matches a panel that names several profiles", () => {
    registerPanel(panel("shared", "lane", ["code", "research"]));

    expect(panelsFor("lane", "code")).toHaveLength(1);
    expect(panelsFor("lane", "research")).toHaveLength(1);
    expect(panelsFor("lane", "ops")).toEqual([]);
  });

  it("mixes profiled and unprofiled panels in one profiled channel", () => {
    registerPanel(panel("plan", "lane"));
    registerPanel(panel("github-code", "lane", ["code"]));

    expect(panelsFor("lane", "code").map((p) => p.id)).toEqual(["plan", "github-code"]);
    expect(panelsFor("lane", null).map((p) => p.id)).toEqual(["plan"]);
  });
});
