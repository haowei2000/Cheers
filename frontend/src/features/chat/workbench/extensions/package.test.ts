import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseExtensionPackage } from "./package";

function archive(manifest: object, files: Record<string, string> = {}): Uint8Array {
  return zipSync(Object.fromEntries([
    ["manifest.json", strToU8(JSON.stringify(manifest))],
    ...Object.entries(files).map(([path, content]) => [path, strToU8(content)] as const),
  ]));
}

const base = {
  schemaVersion: 1,
  id: "example",
  version: "1.0.0",
  title: "Example",
  contributes: { scenes: [], renderers: [] },
  permissions: {},
};

describe("parseExtensionPackage", () => {
  it("resolves scenes, seed files, and stable global ids", async () => {
    const bytes = archive(
      { ...base, contributes: { scenes: [{ id: "main", title: "Main", definition: "scenes/main.json" }], renderers: [] } },
      {
        "scenes/main.json": JSON.stringify({
          items: [{ id: "notes", title: "Notes", file: "notes.md", renderer: "builtin:markdown" }],
          seed: [{ path: "notes.md", source: "seed/main/notes.md" }], pin: ["notes.md"],
        }),
        "seed/main/notes.md": "# Notes",
      }
    );
    const parsed = await parseExtensionPackage(bytes, "global");
    expect(parsed.scenes[0].id).toBe("extension:example:main");
    expect(parsed.scenes[0].seed?.["notes.md"]).toBe("# Notes");
    expect(parsed.scenes[0].views[0].renderer).toBe("builtin:markdown");
  });

  it("rejects renderer code in browser/global scope", async () => {
    const bytes = archive(
      { ...base, contributes: { scenes: [], renderers: [{ id: "r", title: "R", entry: "renderers/r.js", match: [] }] } },
      { "renderers/r.js": "console.log('no')" }
    );
    await expect(parseExtensionPackage(bytes, "global")).rejects.toThrow(/declarative/);
    await expect(parseExtensionPackage(bytes, "personal")).resolves.toMatchObject({ rendererPlugin: { plugin_id: "example" } });
  });

  it("rejects traversal before inflation", async () => {
    const bytes = archive(base, { "seed/main/../secret": "x" });
    await expect(parseExtensionPackage(bytes, "global")).rejects.toThrow(/Unsafe ZIP path/);
  });

  it("accepts declarative automation templates in global packages", async () => {
    const bytes = archive({
      ...base,
      contributes: {
        scenes: [],
        renderers: [],
        automations: [{
          id: "deadline-watch",
          title: "Deadline watch",
          message: "Review upcoming submission deadlines.",
          defaultSchedule: { kind: "interval", everyMinutes: 1440 },
        }],
      },
    });
    const parsed = await parseExtensionPackage(bytes, "global");
    expect(parsed.manifest.contributes.automations?.[0].id).toBe("deadline-watch");
  });

  it("accepts a daily automation template without fixing the user's timezone", async () => {
    const bytes = archive({
      ...base,
      contributes: {
        scenes: [], renderers: [],
        automations: [{
          id: "morning-review", title: "Morning review", message: "Review today's deadlines.",
          defaultSchedule: { kind: "daily", localTime: "09:00" },
        }],
      },
    });
    const parsed = await parseExtensionPackage(bytes, "global");
    expect(parsed.manifest.contributes.automations?.[0].defaultSchedule.kind).toBe("daily");
  });
});
