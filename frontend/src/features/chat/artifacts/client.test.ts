import { describe, expect, it } from "vitest";
import { artifactEditorClient, makeArtifactClient, type Artifact } from "./client";
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
        artifact: { ...artifact, path: "renamed.yaml", version: 8 } };
    };
    const editor = artifactEditorClient(makeFsClient(send, "channel"), send, "channel", artifact);
    expect((await editor.read("old.yaml")).version).toBe(8);
    expect(await editor.write("old.yaml", "value: 2", 8)).toEqual({ path: "renamed.yaml", version: 8 });
    await editor.patch("old.yaml", [{ op: "set", path: ["value"], value: 3 }], 8);
    expect(calls.slice(0, 3).map(({ resource }) => resource)).toEqual([
      "channel.artifacts.read", "channel.artifacts.update", "channel.artifacts.patch",
    ]);
    expect(calls[1].params).toEqual({ channel_id: "channel", artifact_id: "stable", content: "value: 2", if_version: 8 });
    await editor.read(".workbench.json");
    expect(calls[3].resource).toBe("fs.read");
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
    await client.resolve("cheers:desk/report.md");
    await client.resolvePath("Quarterly report #1.html");
    expect(calls).toEqual([
      { resource: "channel.artifacts.list", params: { channel_id: "current", limit: 50, before: "cursor" } },
      { resource: "channel.artifacts.resolve", params: { channel_id: "current", uri: "cheers:desk/report.md" } },
      { resource: "channel.artifacts.resolve", params: { channel_id: "current", path: "Quarterly report #1.html" } },
    ]);
  });
});
