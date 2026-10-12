import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocatorOpenContext } from "./messageLinks";
import { ResourceRefCards, resourceRefCards } from "./ResourceRefCards";
import { ResourceCardProvider } from "./ResourceCardContext";
import { makeFsClient } from "./workbench/fsClient";
import { fileResourceStore } from "./workbench/fileResource";
import example from "./workbench/lens/a2ui/example.a2ui.json";

describe("resource reference cards", () => {
  it("renders a minimal form in the reply with controls outside the navigation link", () => {
    const fs = makeFsClient(vi.fn(), "channel");
    fileResourceStore(fs).publish("forms/report.a2ui.json", { path: "forms/report.a2ui.json", content: JSON.stringify(example), version: 4, is_dir: false });
    const open = vi.fn();
    const html = renderToStaticMarkup(<ResourceCardProvider fs={fs} channelId="channel" filesTick={0} openLocator={open} composeMessage={vi.fn()}>
      <LocatorOpenContext.Provider value={open}><ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: "cheers:desk/forms/report.a2ui.json", title: "Report" }]} /></LocatorOpenContext.Provider>
    </ResourceCardProvider>);
    expect(html).toContain('data-presentation="minimal"');
    expect(html).toContain("Report topic");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Version 4");
    expect(html).toContain('aria-expanded="false"');
    expect(html.indexOf("</a>")).toBeLessThan(html.indexOf("<input"));
    expect(html).not.toContain("Prepare a report"); // The declared summary excludes the full heading.
  });
  it("previews plain source safely without mounting model-supplied HTML", () => {
    const fs = makeFsClient(vi.fn(), "channel");
    fileResourceStore(fs).publish("view.html", { path: "view.html", content: "<script>execute()</script>", version: 1, is_dir: false });
    const open = vi.fn();
    const html = renderToStaticMarkup(<ResourceCardProvider fs={fs} channelId="channel" filesTick={0} openLocator={open} composeMessage={vi.fn()}>
      <LocatorOpenContext.Provider value={open}><ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: "cheers:desk/view.html" }]} /></LocatorOpenContext.Provider>
    </ResourceCardProvider>);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
  });
  it("keeps only supported versioned Cheers resource references", () => {
    const cards = resourceRefCards({ cards: [
      { v: 1, kind: "resource_ref", uri: "cheers:desk/notes.md#L3", title: "Notes" },
      { v: 1, kind: "resource_ref", uri: "cheers:msg/m-1" },
      { v: 1, kind: "resource_ref", uri: "javascript:alert(1)" },
    ] });
    expect(cards).toHaveLength(1);
    const markup = renderToStaticMarkup(
      <LocatorOpenContext.Provider value={vi.fn()}><ResourceRefCards cards={cards} /></LocatorOpenContext.Provider>,
    );
    expect(markup).toContain("Notes");
    expect(markup).toContain("cheers:desk/notes.md#L3");
    expect(markup).not.toContain("javascript:");
  });
});
