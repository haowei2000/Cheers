import { describe, expect, it } from "vitest";
import example from "./example.a2ui.json";
import { a2uiPresentation, acceptsA2UIDocument, parseA2UIDocument, readBinding, setDataPath } from "./document";
import { candidatesFor } from "../../renderers/registry";

const copy = () => JSON.parse(JSON.stringify(example));

describe("persisted A2UI protocol and Cheers catalog", () => {
  it("uses a validated summary root and refuses dangling presentation references", () => {
    const doc = copy();
    const views = a2uiPresentation(doc, parseA2UIDocument(doc), "minimal");
    expect(views.fits).toBe(true);
    expect(views.selected[0].root).toBe("summary");
    expect(a2uiPresentation(doc, parseA2UIDocument(doc), "max").selected[0].root).toBe("root");
    doc.views.minimal.root = "missing";
    expect(() => parseA2UIDocument(doc)).toThrow("Presentation view");
  });
  it("requires expansion for a large form instead of hiding some of its inputs", () => {
    const doc = copy(); delete doc.views;
    for (let at = 0; at < 4; at++) {
      doc.messages[1].updateComponents.components.push({ id: `input-${at}`, component: "TextField", label: `Field ${at}`, value: { path: `/field${at}` } });
      doc.messages[1].updateComponents.components[0].children.push(`input-${at}`);
    }
    const surfaces = parseA2UIDocument(doc);
    expect(a2uiPresentation(doc, surfaces, "minimal").fits).toBe(false);
    expect(a2uiPresentation(doc, surfaces, "medium").fits).toBe(true);
  });
  it("replays the transcript and selects the existing built-in renderer", () => {
    const [surface] = parseA2UIDocument(example);
    expect(surface.components.get("topic")?.sourcePath).toEqual(["messages", 1, "updateComponents", "components", 3]);
    expect(readBinding({ path: "/report/topic" }, surface.data)).toBe("Resource-oriented UI");
    expect(candidatesFor("forms/report.json", JSON.stringify(example), [])[0].id).toBe("builtin:a2ui");
    expect(candidatesFor("form.yaml", "a2ui: v0.9.1\nmessages: []", [])).toEqual([]);
  });
  it("applies component replacement, data removal, and surface deletion in order", () => {
    const doc = copy();
    doc.messages.push({ version: "v0.9.1", updateComponents: { surfaceId: "report", components: [{ id: "title", component: "Text", text: "Updated" }] } });
    doc.messages.push({ version: "v0.9.1", updateDataModel: { surfaceId: "report", path: "/report/includeSources" } });
    const [surface] = parseA2UIDocument(doc);
    expect(surface.components.get("title")?.text).toBe("Updated");
    expect(readBinding({ path: "/report/includeSources" }, surface.data)).toBeUndefined();
    delete doc.views; // Remove presentation references when deleting their surface.
    doc.messages.push({ version: "v0.9.1", deleteSurface: { surfaceId: "report" } });
    expect(parseA2UIDocument(doc)).toEqual([]);
  });
  it("keeps local form drafts separate and resolves escaped pointer segments", () => {
    const original = { "a/b": { "~name": "old" }, list: ["one", "two"] };
    const next = setDataPath(original, "/a~1b/~0name", "new");
    expect(readBinding({ path: "/a~1b/~0name" }, next)).toBe("new");
    expect(original["a/b"]["~name"]).toBe("old");
    expect(setDataPath(original, "/list/0", "changed").list).toEqual(["changed", "two"]);
    expect(() => setDataPath(original, "/list/100000000", "bad")).toThrow("array index");
    expect(() => setDataPath(original, "/a~2b", "bad")).toThrow("data path");
    expect(() => setDataPath(original, "/list/a", "bad")).toThrow("array index");
  });
  it.each([
    ["version", (d: ReturnType<typeof copy>) => { d.a2ui = "v1.0"; }],
    ["catalog", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.catalogId = "https://untrusted.test/catalog"; }],
    ["component", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components[1].component = "Script"; }],
    ["native action", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components[7].action.event.name = "desktop.exec"; }],
    ["cycle", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components[0].children.push("root"); }],
    ["missing child", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components[0].children.push("absent"); }],
    ["duplicate id", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components.push(d.messages[1].updateComponents.components[1]); }],
    ["prototype path", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components[3].value.path = "/__proto__/polluted"; }],
    ["URL script", (d: ReturnType<typeof copy>) => { d.messages[1].updateComponents.components[7].action.event.context.uri = "javascript:alert(1)"; }],
    ["multiple operations", (d: ReturnType<typeof copy>) => { d.messages[0].deleteSurface = { surfaceId: "report" }; }],
  ])("refuses unsupported or unsafe %s", (_name, mutate) => {
    const doc = copy();
    mutate(doc);
    expect(() => parseA2UIDocument(doc)).toThrow();
    expect(acceptsA2UIDocument(doc)).toBe(false);
  });
  it("validates structured requests and registered native openers", () => {
    const doc = copy();
    const event = doc.messages[1].updateComponents.components[6].action.event;
    event.name = "cheers.request";
    event.context.botId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    expect(parseA2UIDocument(doc)).toHaveLength(1);
    event.context.botId = "@handle";
    expect(() => parseA2UIDocument(doc)).toThrow();
    const native = copy();
    const open = native.messages[1].updateComponents.components[7].action.event;
    open.name = "cheers.openNative";
    open.context.opener = "zed";
    expect(parseA2UIDocument(native)).toHaveLength(1);
    open.context.opener = "shell";
    expect(() => parseA2UIDocument(native)).toThrow();
  });
  it("bounds the payload and rejects update before creation", () => {
    const doc = copy();
    doc.messages.shift();
    expect(() => parseA2UIDocument(doc)).toThrow("created");
    const huge = copy();
    huge.messages[1].updateComponents.components[1].text = "x".repeat(256_001);
    expect(() => parseA2UIDocument(huge)).toThrow("too large");
  });
});
