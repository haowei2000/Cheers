import { describe, expect, it } from "vitest";
import { artifactEditorClient, makeArtifactClient, type Artifact } from "./client";
import { fileSessionController } from "../workbench/fileSessionController";
import { makeFsClient } from "../workbench/fsClient";
import { contextItemLocator, locatorToContextItem } from "../context/contextPick";

describe("artifact references", () => {
  it("keeps a canvas node attached to the stable artifact", () => {
    const uri = "cheers:artifact/49ca7c5f-37cb-4f02-831c-e36da3492361#^revenue";
    const item = locatorToContextItem(uri)!;
    expect(item.params.inspectable_id).toBe("revenue");
    expect(contextItemLocator(item)).toBe(uri);
  });
  it("edits by identity and artifact version even when the provider path changes", async () => {
    const calls: { resource: string; params: Record<string, unknown> }[] = [];
    const artifact = { artifact_id: "stable", path: "old.yaml", version: 7 } as Artifact;
    const send = async (resource: string, params: Record<string, unknown>) => {
      calls.push({ resource, params });
      return { kind: "text", content: "value: 1", truncated: false, version: 2,
        uri: "cheers:resource/service/desk/source",
        artifact: { ...artifact, path: "renamed.yaml", version: 8, source_version: 2 } };
    };
    const editor = artifactEditorClient(makeFsClient(send, "channel"), send, "channel", artifact);
    expect(await editor.read("old.yaml")).toMatchObject({ version: 8, source_version: 2, uri: "cheers:resource/service/desk/source" });
    expect(await editor.write("old.yaml", "value: 2", 8)).toEqual({ path: "renamed.yaml", version: 8, source_version: 2 });
    await editor.patch("old.yaml", [{ op: "set", path: ["value"], value: 3 }], 8);
    expect(calls.slice(0, 3).map(({ resource }) => resource)).toEqual([
      "channel.artifacts.read", "channel.artifacts.update", "channel.artifacts.patch",
    ]);
    expect(calls[1].params).toEqual({ channel_id: "channel", artifact_id: "stable", content: "value: 2", if_version: 8 });
    await editor.read(".workbench.json");
    expect(calls[3].resource).toBe("fs.read");
    const session = fileSessionController(editor, "old.yaml", { autoSave: false });
    await session.ensureLoaded();
    expect(session.snapshot()).toMatchObject({ version: 8, sourceVersion: 2, resourceUri: "cheers:resource/service/desk/source" });
    session.actions.editText("value: 4");
    await session.actions.save();
    expect(session.snapshot()).toMatchObject({ version: 8, sourceVersion: 2 });
  });
  it("gives every surface one client, so one artifact has one session", async () => {
    const calls: { resource: string; params: Record<string, unknown> }[] = [];
    const send = async (resource: string, params: Record<string, unknown>) => {
      calls.push({ resource, params });
      return { kind: "text", content: "", truncated: false, artifact: { artifact_id: params.artifact_id, path: null, version: 1, source_version: 1 } };
    };
    const base = makeFsClient(send, "channel");
    const board = { artifact_id: "board", path: "board.canvas.yaml", version: 1 } as Artifact;
    const library = artifactEditorClient(base, send, "channel", board);
    // A refreshed copy of the same artifact, and a different artifact, from another surface.
    const collection = artifactEditorClient(base, send, "channel", { ...board, version: 2 });
    const other = artifactEditorClient(base, send, "channel", { artifact_id: "notes", path: "notes.md", version: 1 } as Artifact);
    expect(collection).toBe(library);
    expect(other).toBe(library);
    expect(fileSessionController(collection, "board.canvas.yaml")).toBe(fileSessionController(library, "board.canvas.yaml"));
    await library.read("board.canvas.yaml");
    await library.read("notes.md");
    expect(calls.map(({ params }) => params.artifact_id)).toEqual(["board", "notes"]);
  });
  it("follows a rename and a recreated file to the right artifact", async () => {
    const calls: { resource: string; params: Record<string, unknown> }[] = [];
    const send = async (resource: string, params: Record<string, unknown>) => {
      calls.push({ resource, params });
      return { kind: "text", content: "", truncated: false, path: params.path, version: 1, is_dir: false,
        artifact: { artifact_id: params.artifact_id, path: null, version: 1, source_version: 1 } };
    };
    const base = makeFsClient(send, "channel");
    const editor = artifactEditorClient(base, send, "channel", { artifact_id: "first", path: "a.md" } as Artifact);
    artifactEditorClient(base, send, "channel", { artifact_id: "first", path: "b.md" } as Artifact);
    await editor.read("a.md");
    await editor.read("b.md");
    expect(calls.map(({ resource }) => resource)).toEqual(["fs.read", "channel.artifacts.read"]);
    artifactEditorClient(base, send, "channel", { artifact_id: "second", path: "b.md" } as Artifact);
    await editor.read("b.md");
    expect(calls[2].params.artifact_id).toBe("second");
  });
  it("round-trips the stable identity through composer context", () => {
    const uri = "cheers:artifact/49ca7c5f-37cb-4f02-831c-e36da3492361";
    const item = locatorToContextItem(uri, "Report")!;
    expect(item.verb).toBe("channel.artifacts.read");
    expect(item.label).toBe("Report");
    expect(contextItemLocator(item)).toBe(uri);
  });
  it("pins every request to the current channel and forwards pagination", async () => {
    const calls: unknown[] = [];
    const client = makeArtifactClient(async (resource, params) => { calls.push({ resource, params }); return {}; }, "current");
    await client.list("cursor");
    await client.list(undefined, "canvas");
    await client.create("canvases/plan.canvas.yaml", "canvas: 1\n", "key-1");
    await client.resolve("cheers:desk/report.md");
    await client.resolvePath("Quarterly report #1.html");
    expect(calls).toEqual([
      { resource: "channel.artifacts.list", params: { channel_id: "current", limit: 50, before: "cursor" } },
      { resource: "channel.artifacts.list", params: { channel_id: "current", limit: 50, type: "canvas" } },
      { resource: "channel.artifacts.create", params: { channel_id: "current", path: "canvases/plan.canvas.yaml", content: "canvas: 1\n", idempotency_key: "key-1" } },
      { resource: "channel.artifacts.resolve", params: { channel_id: "current", uri: "cheers:desk/report.md" } },
      { resource: "channel.artifacts.resolve", params: { channel_id: "current", path: "Quarterly report #1.html" } },
    ]);
  });
});
