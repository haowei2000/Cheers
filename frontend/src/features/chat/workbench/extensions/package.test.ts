import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasCode, parseExtensionPackage } from "./package";

function archive(manifest: object, files: Record<string, string> = {}): Uint8Array {
  return zipSync(Object.fromEntries([
    ["manifest.json", strToU8(JSON.stringify(manifest))],
    ...Object.entries(files).map(([path, content]) => [path, strToU8(content)] as const),
  ]));
}

/** Rewrite one entry's declared uncompressed size in the central directory, leaving
 * the deflate stream alone. This is the shape of a package that two parsers read
 * differently: `unzipSync` believes the declaration, the Rust validator reads the
 * stream. */
function understateSize(zip: Uint8Array, entry: string, declared: number): Uint8Array {
  const bytes = new Uint8Array(zip);
  const view = new DataView(bytes.buffer);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("no EOCD in fixture");
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === entry) {
      view.setUint32(offset + 24, declared, true);
      return bytes;
    }
    offset = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error(`no entry ${entry} in fixture`);
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
  it("parses the same deterministic fixture as the SDK and server", async () => {
    const path = fileURLToPath(new URL("../../../../../../fixtures/workbench/scene-renderer.cheers-extension", import.meta.url));
    const parsed = await parseExtensionPackage(new Uint8Array(readFileSync(path)), "personal");
    expect(parsed.manifest.id).toBe("example-notes");
    expect(parsed.scenes).toHaveLength(1);
    expect(parsed.rendererExtension?.manifest.renderers).toHaveLength(1);
    expect(parsed.manifest.contributes.automations).toHaveLength(1);
  });

  it("parses the official data-only research planner fixture in global scope", async () => {
    const path = fileURLToPath(new URL("../../../../../../fixtures/workbench/research-planner.cheers-extension", import.meta.url));
    const parsed = await parseExtensionPackage(new Uint8Array(readFileSync(path)), "global");
    expect(parsed.manifest.id).toBe("research-planner");
    expect(parsed.scenes[0].views).toHaveLength(3);
    expect(parsed.manifest.contributes.automations?.[0].id).toBe("deadline-check");
    expect(parsed.rendererExtension).toBeNull();
  });

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
    await expect(parseExtensionPackage(bytes, "personal")).resolves.toMatchObject({ rendererExtension: { extensionId: "example" } });
  });

  it("rejects automation management in browser/global scope", async () => {
    const bytes = archive({ ...base, permissions: { "automation.manage": true } });
    await expect(parseExtensionPackage(bytes, "global")).rejects.toThrow(/declarative/);
    await expect(parseExtensionPackage(bytes, "personal")).resolves.toBeDefined();
  });

  it("rejects legacy or unknown permission names", async () => {
    await expect(parseExtensionPackage(
      archive({ ...base, permissions: { fileWrite: true } }),
      "personal"
    )).rejects.toThrow(/Unknown permission/);
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

  /** The bug this guards: a renderer truncated mid-file is still valid JavaScript,
   * and a truncated seed file reaches the workspace with nothing to signal it. The
   * client would run one extension while the server had validated another. */
  it("rejects a package whose central directory understates an entry's real size", async () => {
    const body = "// ".concat("payload;".repeat(200));
    const bytes = archive(
      { ...base, contributes: { scenes: [], renderers: [{ id: "view", title: "View", entry: "renderers/view.js" }] } },
      { "renderers/view.js": body }
    );
    await expect(parseExtensionPackage(bytes, "personal")).resolves.toBeTruthy();
    const lying = understateSize(bytes, "renderers/view.js", 20);
    await expect(parseExtensionPackage(lying, "personal")).rejects.toThrow(/declared size/);
  });

  it("rejects a package whose central directory overstates an entry's real size", async () => {
    const bytes = archive({ ...base }, { "seed/main/notes.md": "# Notes" });
    const lying = understateSize(bytes, "seed/main/notes.md", 4096);
    await expect(parseExtensionPackage(lying, "personal")).rejects.toThrow(/declared size/);
  });

  /** `hasCode` decides two things that have to stay the same thing: whether the
   * server refuses the package, and whether dropping it into the drawer asks for
   * consent first. If they ever drift, a package the server would not store gets
   * activated on desktop without a word. */
  it("flags exactly the packages global scope refuses", async () => {
    const declarative = { ...base };
    expect(hasCode(declarative as never)).toBe(false);
    await expect(parseExtensionPackage(archive(declarative), "global")).resolves.toBeTruthy();

    const carriers: object[] = [
      { ...base, permissions: { "file.write": true } },
      { ...base, permissions: { "channel.resources": ["channel.info"] } },
      { ...base, permissions: { "navigation.open": true } },
      { ...base, permissions: { "composer.prefill": true } },
      { ...base, permissions: { "automation.manage": true } },
      { ...base, permissions: { network: "unrestricted" } },
      { ...base, contributes: { scenes: [], renderers: [{ id: "view", title: "View", entry: "renderers/view.js" }] } },
    ];
    for (const manifest of carriers) {
      expect(hasCode(manifest as never), JSON.stringify(manifest)).toBe(true);
      await expect(
        parseExtensionPackage(archive(manifest, { "renderers/view.js": "export default {};" }), "global")
      ).rejects.toThrow(/declarative/);
    }
  });
});
