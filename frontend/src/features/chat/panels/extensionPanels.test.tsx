import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExtensionSummary } from "../workbench/extensions/api";
import { registerExtensionPanels } from "./extensionPanels";

const captured = vi.hoisted(() => ({ panels: [] as Array<{ render: (data: unknown) => React.ReactNode }> }));
vi.mock("./definePanel", () => ({ defineDataPanel: (definition: unknown) => definition }));
vi.mock("./registry", () => ({ registerPanel: (panel: typeof captured.panels[number]) => captured.panels.push(panel) }));

describe("extension file panels", () => {
  it("uses the filename and file-owned columns even when a manifest requests another view", () => {
    registerExtensionPanels([{ id: "suffix-test", panels: [{ id: "table", title: "Table",
      source: { kind: "fs", path: "tasks.table.json" }, view: "builtin:kanban",
      config: { columns: [{ key: "wrong", label: "Wrong column" }] } }] }] as ExtensionSummary[]);
    const output = renderToStaticMarkup(<>{captured.panels.at(-1)!.render({ columns: [{ key: "task", label: "Task" }], rows: [{ task: "Keep this row" }] })}</>);
    expect(output).toContain("Keep this row");
    expect(output).toContain("Task");
    expect(output).not.toContain("Wrong column");
  });
  it("shows source for generic JSON rather than obeying a manifest binding", () => {
    registerExtensionPanels([{ id: "source-test", panels: [{ id: "source", title: "Source",
      source: { kind: "fs", path: "tasks.json" }, view: "builtin:kanban" }] }] as ExtensionSummary[]);
    const output = renderToStaticMarkup(<>{captured.panels.at(-1)!.render({ columns: [] })}</>);
    expect(output).toContain("<pre");
    expect(output).toContain("columns");
  });
});
