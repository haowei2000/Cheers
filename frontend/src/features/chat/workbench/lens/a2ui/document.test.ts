import { describe, expect, it } from "vitest";
import example from "./example.a2ui.json";
import { a2uiPresentation, acceptsA2UIDocument, parseA2UIDocument, readBinding, setDataPath, validateFieldChecks } from "./document";
import { viewFor } from "../../renderers/registry";

const copy = () => JSON.parse(JSON.stringify(example));

const legacyV1Doc = () => ({
  a2ui: "v0.9.1",
  messages: [
    { version: "v0.9.1", createSurface: { surfaceId: "report", catalogId: "urn:cheers:a2ui:catalog:v1" } },
    {
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "report",
        components: [
          { id: "root", component: "Column", children: ["title", "topic", "prepare"] },
          { id: "title", component: "Text", text: "Legacy v0.9.1" },
          { id: "topic", component: "TextField", label: "Topic", value: { path: "/report/topic" } },
          {
            id: "prepare",
            component: "Button",
            label: "Send",
            action: { event: { name: "cheers.compose", context: { actionId: "report.prepare", payload: { topic: { path: "/report/topic" } } } } },
          },
        ],
      },
    },
    { version: "v0.9.1", updateDataModel: { surfaceId: "report", path: "/", value: { report: { topic: "Old topic" } } } },
  ],
});

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
      doc.messages[0].createSurface.components.push({ id: `input-${at}`, component: "TextField", label: `Field ${at}`, value: { "@path": `/field${at}` } });
      doc.messages[0].createSurface.components[0].children.push(`input-${at}`);
    }
    const surfaces = parseA2UIDocument(doc);
    expect(a2uiPresentation(doc, surfaces, "minimal").fits).toBe(false);
    expect(a2uiPresentation(doc, surfaces, "medium").fits).toBe(true);
  });
  it("replays single-message v1.0 createSurface and selects the existing built-in renderer", () => {
    const [surface] = parseA2UIDocument(example);
    expect(surface.components.get("topic")?.sourcePath).toEqual(["messages", 0, "createSurface", "components", 3]);
    expect(surface.components.get("topic")?.value).toEqual({ path: "/report/topic" });
    expect(surface.components.get("topic")?.placeholder).toBe("Enter a report topic");
    expect(surface.components.get("topic")?.checks).toEqual([{ rule: "required", message: "Please enter a report topic." }]);
    expect(surface.components.get("prepare")?.accessibility).toEqual({ description: "Prepares a structured report draft in the chat composer." });
    expect(readBinding({ path: "/report/topic" }, surface.data)).toBe("Resource-oriented UI");
    expect(viewFor("forms/report.a2ui.json")?.id).toBe("builtin:a2ui");
    expect(viewFor("form.yaml")).toBeUndefined();
  });
  it("remains backward compatible with persisted v0.9.1 / catalog:v1 documents", () => {
    const [surface] = parseA2UIDocument(legacyV1Doc());
    expect(surface.components.get("topic")?.value).toEqual({ path: "/report/topic" });
    expect(readBinding({ path: "/report/topic" }, surface.data)).toBe("Old topic");
  });
  it("applies component replacement, data removal, and surface deletion in order", () => {
    const doc = copy();
    doc.messages.push({ version: "1.0", updateComponents: { surfaceId: "report", components: [{ id: "title", component: "Text", text: "Updated" }] } });
    doc.messages.push({ version: "1.0", updateDataModel: { surfaceId: "report", path: "/report/includeSources" } });
    const [surface] = parseA2UIDocument(doc);
    expect(surface.components.get("title")?.text).toBe("Updated");
    expect(readBinding({ path: "/report/includeSources" }, surface.data)).toBeUndefined();
    delete doc.views; // Remove presentation references when deleting their surface.
    doc.messages.push({ version: "1.0", deleteSurface: { surfaceId: "report" } });
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
  it("evaluates whitelisted @checks rules", () => {
    expect(validateFieldChecks("   ", [{ rule: "required", message: "Required" }])).toBe("Required");
    expect(validateFieldChecks("ab", [{ rule: "minLength", value: 3 }])).toContain("at least 3");
    expect(validateFieldChecks("abcd", [{ rule: "maxLength", value: 3 }])).toContain("at most 3");
    expect(validateFieldChecks("abc", [{ rule: "pattern", value: "^[0-9]+$", message: "Digits only" }])).toBe("Digits only");
    expect(validateFieldChecks("123", [{ rule: "required" }, { rule: "minLength", value: 2 }, { rule: "maxLength", value: 5 }, { rule: "pattern", value: "^[0-9]+$" }])).toBeNull();
  });
  it.each([
    ["version", (d: ReturnType<typeof copy>) => { d.a2ui = "v1.0"; }],
    ["catalog", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.catalogId = "https://untrusted.test/catalog"; }],
    ["v1 catalog in v1.0", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.catalogId = "urn:cheers:a2ui:catalog:v1"; }],
    ["v0.9 path in v1.0", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[3].value = { path: "/report/topic" }; }],
    ["component", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[1].component = "Script"; }],
    ["native action", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[7].action.event.name = "desktop.exec"; }],
    ["cycle", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[0].children.push("root"); }],
    ["missing child", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[0].children.push("absent"); }],
    ["duplicate id", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components.push(d.messages[0].createSurface.components[1]); }],
    ["prototype path", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[3].value["@path"] = "/__proto__/polluted"; }],
    ["URL script", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[7].action.event.context.uri = "javascript:alert(1)"; }],
    ["multiple operations", (d: ReturnType<typeof copy>) => { d.messages[0].deleteSurface = { surfaceId: "report" }; }],
    ["unsupported check rule", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[3]["@checks"] = [{ rule: "eval" }]; }],
    ["invalid check regex", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[3]["@checks"] = [{ rule: "pattern", value: "[unclosed" }]; }],
  ])("refuses unsupported or unsafe %s", (_name, mutate) => {
    const doc = copy();
    mutate(doc);
    expect(() => parseA2UIDocument(doc)).toThrow();
    expect(acceptsA2UIDocument(doc)).toBe(false);
  });
  it("refuses v1.0 syntax inside legacy v0.9.1 documents", () => {
    const legacy = legacyV1Doc();
    (legacy.messages[1].updateComponents!.components[2] as Record<string, unknown>).value = { "@path": "/report/topic" };
    expect(() => parseA2UIDocument(legacy)).toThrow();
  });
  it("validates structured requests and registered native openers", () => {
    const doc = copy();
    const event = doc.messages[0].createSurface.components[6].action.event;
    event.name = "cheers.request";
    event.context.botId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    expect(parseA2UIDocument(doc)).toHaveLength(1);
    event.context.botId = "@handle";
    expect(() => parseA2UIDocument(doc)).toThrow();
    const native = copy();
    const open = native.messages[0].createSurface.components[7].action.event;
    open.name = "cheers.openNative";
    open.context.opener = "zed";
    expect(parseA2UIDocument(native)).toHaveLength(1);
    open.context.opener = "shell";
    expect(() => parseA2UIDocument(native)).toThrow();
  });
  it("bounds the payload and rejects update before creation", () => {
    const doc = copy();
    doc.messages = [{ version: "1.0", updateDataModel: { surfaceId: "report", path: "/x", value: 1 } }];
    expect(() => parseA2UIDocument(doc)).toThrow("created");
    const huge = copy();
    huge.messages[0].createSurface.components[1].text = "x".repeat(256_001);
    expect(() => parseA2UIDocument(huge)).toThrow("too large");
  });
});
