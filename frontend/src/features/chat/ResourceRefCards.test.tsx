import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LocatorOpenContext } from "./messageLinks";
import { ResourceRefCards, resourceRefCards } from "./ResourceRefCards";
import { ResourceCardProvider } from "./ResourceCardContext";
import { makeFsClient } from "./workbench/fsClient";
import { fileResourceStore } from "./workbench/fileResource";
import { artifactReferenceStore } from "./artifacts/referenceStore";
import example from "./workbench/lens/a2ui/example.a2ui.json";

describe("resource reference cards", () => {
  it("renders an A2UI form directly in the reply without enclosure link chrome", () => {
    const fs = makeFsClient(vi.fn(), "channel");
    fileResourceStore(fs).publish("forms/report.a2ui.json", { path: "forms/report.a2ui.json", content: JSON.stringify(example), version: 4, is_dir: false });
    const open = vi.fn();
    const html = renderToStaticMarkup(<ResourceCardProvider fs={fs} channelId="channel" filesTick={0} openLocator={open} composeMessage={vi.fn()}>
      <LocatorOpenContext.Provider value={open}><ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: "cheers:desk/forms/report.a2ui.json", title: "Report", description: "Complete this form to prepare your report." }]} /></LocatorOpenContext.Provider>
    </ResourceCardProvider>);
    expect(html).toContain('data-presentation="medium"');
    expect(html).toContain("a2ui-textfield");
    expect(html).toContain("a2ui-checkbox");
    expect(html).not.toContain("Enclosure 01");
    expect(html).not.toContain("Details for Report");
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
  it("resolves an artifact link through the catalog: title, type and the source preview", async () => {
    const id = "0f8b6c2e-4d3a-4b1c-9e7f-2a5d8c1b3e60";
    const artifact = { artifact_id: id, title: "roadmap.md", source_kind: "text", source_id: "f1", path: "dev/roadmap.md",
      content_type: "text/markdown", size_bytes: 9, version: 3, availability: "ready" };
    const send = vi.fn(async (verb: string) => verb === "channel.artifacts.get" ? artifact
      : { artifact, content: "# Roadmap", kind: "text", truncated: false });
    const fs = makeFsClient(send, "channel");
    fileResourceStore(fs).publish("dev/roadmap.md", { path: "dev/roadmap.md", content: "# Roadmap", version: 2, is_dir: false });
    await artifactReferenceStore(send, "channel").load(id);
    const open = vi.fn();
    const html = renderToStaticMarkup(<ResourceCardProvider fs={fs} channelId="channel" filesTick={0} sendResourceReq={send} openLocator={open} composeMessage={vi.fn()}>
      <LocatorOpenContext.Provider value={open}><ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: `cheers:artifact/${id}` }]} /></LocatorOpenContext.Provider>
    </ResourceCardProvider>);
    expect(html).toContain('aria-label="Preview of dev/roadmap.md"');
    expect(html).toContain("Roadmap</h1>");
    expect(html).not.toContain("Loading artifact");
  });
  it("says why an artifact link cannot be previewed instead of showing nothing", async () => {
    const id = "1f8b6c2e-4d3a-4b1c-9e7f-2a5d8c1b3e61";
    const send = vi.fn(async () => ({ artifact_id: id, title: "report.pdf", source_kind: "attachment", source_id: "f2", path: null,
      content_type: "application/pdf", size_bytes: 9, version: 1, availability: "expired" }));
    await artifactReferenceStore(send, "channel").load(id);
    const open = vi.fn();
    const html = renderToStaticMarkup(<ResourceCardProvider fs={makeFsClient(send, "channel")} channelId="channel" filesTick={0} sendResourceReq={send} openLocator={open} composeMessage={vi.fn()}>
      <LocatorOpenContext.Provider value={open}><ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: `cheers:artifact/${id}` }]} /></LocatorOpenContext.Provider>
    </ResourceCardProvider>);
    expect(html).toContain("Expired. Ask the author to deliver a new copy.");
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
    expect(markup).toContain(encodeURIComponent("cheers:desk/notes.md#L3"));
    expect(markup).not.toContain("javascript:");
  });
  it("renders an isolated TSX canvas in the reply preview", () => {
    const fs = makeFsClient(vi.fn(), "channel");
    const tsx = `
/**
 * @cheers-actions
 * [{ "actionId": "calc", "name": "cheers.request", "botId": "00000000-0000-0000-0000-000000000001" }]
 */
export default function Calc() { return <div>Calculator</div>; }
`;
    fileResourceStore(fs).publish("cards/calc.tsx", { path: "cards/calc.tsx", content: tsx, version: 1, is_dir: false });
    const open = vi.fn();
    const html = renderToStaticMarkup(<ResourceCardProvider fs={fs} channelId="channel" filesTick={0} openLocator={open} composeMessage={vi.fn()}>
      <LocatorOpenContext.Provider value={open}><ResourceRefCards cards={[{ v: 1, kind: "resource_ref", uri: "cheers:desk/cards/calc.tsx", title: "Calculator" }]} /></LocatorOpenContext.Provider>
    </ResourceCardProvider>);
    expect(html).toContain("<iframe");
    expect(html).toContain('title="REACT Canvas"');
    expect(html).not.toContain("Version 1");
  });
});
