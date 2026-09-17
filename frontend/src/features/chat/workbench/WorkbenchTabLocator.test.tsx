import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchTabLocator, type TabLocatorItem } from "./WorkbenchTabLocator";

const sampleTabs: TabLocatorItem[] = [
  { path: "README.md", label: "README.md" },
  { path: "src/main.rs", label: "main.rs", isDirty: true },
  { path: "config.json", label: "config.json" },
];

describe("WorkbenchTabLocator", () => {
  it("renders a vertical tick ruler with active tab indicator", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTabLocator
        tabs={sampleTabs}
        selectedIndex={1}
        onSelectTab={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Tab locator"');
    expect(markup).toContain('aria-label="main.rs (2 of 3)"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('title="Unsaved changes"');
    // Active tick has w-4
    expect(markup).toContain("w-4");
    // Adjacent tick has w-2.5
    expect(markup).toContain("w-2.5");
  });

  it("returns null when tabs array is empty", () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTabLocator
        tabs={[]}
        selectedIndex={0}
        onSelectTab={() => {}}
      />,
    );

    expect(markup).toBe("");
  });
});
