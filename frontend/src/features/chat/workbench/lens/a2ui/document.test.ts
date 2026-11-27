import { describe, expect, it } from "vitest";
import example from "./example.a2ui.json";
import { A2UI_CATALOG, acceptsA2UIDocument, createA2UIProcessor, readBinding, setDataPath } from "./document";
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

const legacyV2Doc = () => ({
  a2ui: "1.0",
  messages: [
    {
      version: "1.0",
      createSurface: {
        surfaceId: "report",
        catalogId: "urn:cheers:a2ui:catalog:v2",
        components: [
          { id: "root", component: "Column", children: ["topic", "prepare"] },
          {
            id: "topic",
            component: "TextField",
            label: "Topic",
            value: { "@path": "/report/topic" },
            "@checks": [{ rule: "required", message: "Required" }],
          },
          {
            id: "prepare",
            component: "Button",
            label: "Send",
            action: { event: { name: "cheers.compose", context: { actionId: "report.prepare", payload: { topic: { "@path": "/report/topic" } } } } },
          },
        ],
        dataModel: { report: { topic: "V2 topic" } },
      },
    },
  ],
});

describe("official @a2ui/web_core + basicCatalog integration", () => {
  it("uses Google A2UI 1.0 basicCatalog and validates presentation views", () => {
    expect(example.messages[0].createSurface.catalogId).toBe(A2UI_CATALOG);
    const min = createA2UIProcessor(copy(), { presentation: "minimal" });
    expect(min.fits).toBe(true);
    expect(min.surfaces[0].componentsModel.get("root")?.properties.children).toEqual(["summary"]);
    min.processor.dispose();

    const doc = copy();
    doc.views.minimal.root = "missing";
    expect(() => createA2UIProcessor(doc, { presentation: "minimal" })).toThrow("Presentation view");
  });

  it("requires expansion for a large form in minimal presentation", () => {
    const doc = copy();
    delete doc.views;
    for (let at = 0; at < 4; at++) {
      doc.messages[0].createSurface.components.push({ id: `input_${at}`, component: "TextField", label: `Field ${at}`, value: { "@path": `/field${at}` } });
      doc.messages[0].createSurface.components[0].children.push(`input_${at}`);
    }
    const min = createA2UIProcessor(doc, { presentation: "minimal" });
    expect(min.fits).toBe(false);
    min.processor.dispose();

    const med = createA2UIProcessor(doc, { presentation: "medium" });
    expect(med.fits).toBe(true);
    med.processor.dispose();
  });

  it("supports all Google basicCatalog components such as Card, Slider, ChoicePicker, Divider", () => {
    const richDoc = {
      a2ui: "1.0",
      messages: [
        {
          version: "1.0",
          createSurface: {
            surfaceId: "rich",
            catalogId: A2UI_CATALOG,
            components: [
              { id: "root", component: "Card", child: "body" },
              { id: "body", component: "Column", children: ["heading", "sep", "slider", "choice"] },
              { id: "heading", component: "Text", text: "Rich Basic Catalog" },
              { id: "sep", component: "Divider" },
              { id: "slider", component: "Slider", label: "Count", value: { "@path": "/count" }, min: 0, max: 10 },
              {
                id: "choice",
                component: "ChoicePicker",
                label: "Mode",
                value: { "@path": "/modes" },
                options: [
                  { label: "Fast", value: "fast" },
                  { label: "Deep", value: "deep" },
                ],
              },
            ],
            dataModel: { count: 5, modes: ["fast"] },
          },
        },
      ],
    };
    expect(acceptsA2UIDocument(richDoc)).toBe(true);
    const { processor, surfaces } = createA2UIProcessor(richDoc);
    expect(surfaces[0].componentsModel.get("root")?.type).toBe("Card");
    expect(surfaces[0].componentsModel.get("slider")?.type).toBe("Slider");
    expect(surfaces[0].componentsModel.get("choice")?.type).toBe("ChoicePicker");
    processor.dispose();
  });

  it("selects the built-in a2ui renderer for .a2ui.json files", () => {
    expect(viewFor("forms/report.a2ui.json")?.id).toBe("builtin:a2ui");
    expect(viewFor("form.yaml")).toBeUndefined();
  });

  it("remains backward compatible with legacy v0.9.1 / catalog:v1 and catalog:v2 documents", () => {
    const v1 = createA2UIProcessor(legacyV1Doc());
    expect(v1.surfaces[0].dataModel.get("/report/topic")).toBe("Old topic");
    expect(v1.surfaces[0].componentsModel.get("prepare")?.properties.child).toBe("prepare__label");
    v1.processor.dispose();

    const v2 = createA2UIProcessor(legacyV2Doc());
    expect(v2.surfaces[0].dataModel.get("/report/topic")).toBe("V2 topic");
    expect(v2.surfaces[0].componentsModel.get("prepare")?.properties.child).toBe("prepare__label");
    v2.processor.dispose();
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
    ["v1 catalog in v1.0", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.catalogId = "urn:cheers:a2ui:catalog:v1"; }],
    ["unregistered cheers action", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[7].action.event.name = "cheers.unknown"; }],
    ["bad opener", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components[7].action.event = { name: "cheers.openNative", context: { uri: "cheers:desk/a.md", opener: "bash" } }; }],
    ["missing root", (d: ReturnType<typeof copy>) => { d.messages[0].createSurface.components = d.messages[0].createSurface.components.filter((c: { id: string }) => c.id !== "root"); }],
  ])("rejects invalid %s", (_label, mutate) => {
    const doc = copy();
    mutate(doc);
    expect(() => createA2UIProcessor(doc)).toThrow();
  });
});
