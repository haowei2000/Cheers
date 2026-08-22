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
  });
});
