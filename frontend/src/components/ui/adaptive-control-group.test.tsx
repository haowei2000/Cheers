import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Activity, LayoutDashboard } from "lucide-react";
import {
  AdaptiveControlGroup,
  chooseAdaptiveControlPresentation,
} from "./adaptive-control-group";

describe("chooseAdaptiveControlPresentation", () => {
  const widths = { iconText: 420, text: 300, icon: 180, collapsed: 132 };

  it("chooses the richest presentation that fits the local slot", () => {
    expect(chooseAdaptiveControlPresentation(500, widths)).toBe("iconText");
    expect(chooseAdaptiveControlPresentation(350, widths)).toBe("text");
    expect(chooseAdaptiveControlPresentation(220, widths)).toBe("icon");
    expect(chooseAdaptiveControlPresentation(150, widths)).toBe("collapsed");
  });

  it("falls back to the smallest allowed presentation", () => {
    expect(chooseAdaptiveControlPresentation(80, widths)).toBe("collapsed");
  });

  it("respects a role-specific presentation order", () => {
    expect(chooseAdaptiveControlPresentation(350, widths, ["iconText", "icon", "collapsed"])).toBe("icon");
  });
});

describe("AdaptiveControlGroup", () => {
  it("renders structured navigation with all measurable presentations", () => {
    const markup = renderToStaticMarkup(
      <AdaptiveControlGroup
        kind="navigation"
        ariaLabel="ViewBoard sections"
        items={[
          { id: "plan", label: "Plan", icon: LayoutDashboard, selected: true },
          { id: "activity", label: "Activity", icon: Activity },
        ]}
      />,
    );

    expect(markup).toContain('data-adaptive-control-group=""');
    expect(markup).toContain('data-presentation="iconText"');
    expect(markup).toContain('data-adaptive-probe="collapsed"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("ViewBoard sections");
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain("bg-control");
  });

  it("passes each measured presentation to rich controls", () => {
    const markup = renderToStaticMarkup(
      <AdaptiveControlGroup
        kind="navigation"
        ariaLabel="Scenes"
        items={[{
          id: "board",
          label: "Board",
          selected: true,
          control: (presentation) => (
            <button type="button" data-rich-presentation={presentation}>Board</button>
          ),
        }]}
      />,
    );

    expect(markup).toContain('data-rich-presentation="iconText"');
    expect(markup).toContain('data-rich-presentation="text"');
    expect(markup).toContain('data-rich-presentation="icon"');
  });
});

describe("chooseAdaptiveControlPresentation — ViewBoard slot", () => {
  // Measured in the running ViewBoard (six boards, compact triggers): the icon row
  // intrinsically wants 188px and the collapsed dropdown 128px.
  const widths = { iconText: 514, text: 382, icon: 188, collapsed: 128 };

  it("draws the icon row once the slot can hold it", () => {
    expect(chooseAdaptiveControlPresentation(200, widths, ["icon", "collapsed"])).toBe("icon");
  });

  it("falls back to the dropdown in the 420px panel's 98px nav slot", () => {
    expect(chooseAdaptiveControlPresentation(98, widths, ["icon", "collapsed"])).toBe("collapsed");
  });
});
