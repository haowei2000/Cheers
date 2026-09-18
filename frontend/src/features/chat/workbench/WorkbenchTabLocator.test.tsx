import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  WorkbenchTabLocator,
  MAX_LOCATOR_TICKS,
  type TabLocatorItem,
} from "./WorkbenchTabLocator";

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

  it("renders tick count equal to tab count when tabs <= MAX_LOCATOR_TICKS", () => {
    const twoTabs: TabLocatorItem[] = [
      { path: "a.txt", label: "a.txt" },
      { path: "b.txt", label: "b.txt" },
    ];
    const markup = renderToStaticMarkup(
      <WorkbenchTabLocator
        tabs={twoTabs}
        selectedIndex={0}
        onSelectTab={() => {}}
      />,
    );

    const tabsRendered = markup.match(/role="tab"/g) ?? [];
    expect(tabsRendered.length).toBe(2);
    expect(markup).not.toContain("guide-top");
    expect(markup).not.toContain("guide-bottom");
  });

  it("caps tick count at MAX_LOCATOR_TICKS when tabs exceed the limit", () => {
    const manyTabs: TabLocatorItem[] = Array.from({ length: 30 }, (_, i) => ({
      path: `file-${i}.txt`,
      label: `file-${i}.txt`,
    }));
    const markup = renderToStaticMarkup(
      <WorkbenchTabLocator
        tabs={manyTabs}
        selectedIndex={15}
        onSelectTab={() => {}}
      />,
    );

    const tabsRendered = markup.match(/role="tab"/g) ?? [];
    expect(tabsRendered.length).toBe(MAX_LOCATOR_TICKS);
    expect(markup).toContain('aria-selected="true"');
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
