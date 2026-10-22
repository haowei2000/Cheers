import { describe, expect, it, vi } from "vitest";
import { ResourceError } from "@/lib/realtimeTransport";
import type { FileContent, FsClient } from "./fsClient";
import { fileResourceStore } from "./fileResource";
import { mutateWorkbenchConfiguration, refreshWorkbenchConfiguration } from "./workbenchConfiguration";
import { commitSharedLayout } from "../hooks/useChannelLayout";
import { clearClientSessionData } from "@/lib/clientSession";

function server(initial: Record<string, unknown>) {
  let document = structuredClone(initial);
  let version = 1;
  const fs: FsClient = {
    ls: vi.fn(), rm: vi.fn(), patch: vi.fn(),
    read: vi.fn(async () => ({ path: ".workbench.json", content: JSON.stringify(document), version, is_dir: false })),
    write: vi.fn(async (_path, content, expected) => {
      if (expected !== version) throw new ResourceError("VERSION_CONFLICT", "changed");
      document = JSON.parse(content);
      return { path: ".workbench.json", version: ++version };
    }),
  };
  return { fs, latest: () => document, change: (next: Record<string, unknown>) => { document = next; version++; } };
}

describe("shared Workbench configuration transactions", () => {
  it("a drawer mutation preserves layout, Collections and unknown fields changed since the drawer opened", async () => {
    const backend = server({ pinned: [] });
    // This snapshot represents the already-open drawer. Its next action must use
    // the current server document, not replay the fields in this old snapshot.
    await fileResourceStore(backend.fs).read(".workbench.json");
    const concurrent = { pinned: ["agent.md"], layout: { version: 1, panels: { files: { open: true } } },
      scene_state: { version: 1, order: ["new"], titles: {}, items: { new: ["notes.md"] } }, future: { enabled: true } };
    backend.change(concurrent);
    await mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = [...document.pinned as string[], "human.md"]; });
    expect(backend.latest()).toMatchObject({ ...concurrent, pinned: ["agent.md", "human.md"] });
    expect(fileResourceStore(backend.fs).snapshot(".workbench.json").file?.content).toContain("human.md");
  });

  it("replays only its own field mutation after an external CAS conflict", async () => {
    const backend = server({ pinned: [], future: { keep: true } });
    const write = vi.mocked(backend.fs.write).getMockImplementation()!;
    vi.mocked(backend.fs.write).mockImplementationOnce(async () => {
      backend.change({ pinned: ["agent.md"], future: { keep: true }, bindings: { "board.json": "builtin:chart" } });
      throw new ResourceError("VERSION_CONFLICT", "changed");
    }).mockImplementation(write);
    await mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = [...document.pinned as string[], "human.md"]; });
    expect(backend.latest()).toMatchObject({ pinned: ["agent.md", "human.md"], bindings: { "board.json": "builtin:chart" }, future: { keep: true } });
    expect(backend.fs.write).toHaveBeenCalledTimes(2);
    expect(vi.mocked(backend.fs.write).mock.calls.map((call) => call[2])).toEqual([1, 2]);
  });

  it("serializes layout and pin actions from the same client and notifies both subscribers", async () => {
    const backend = server({ pinned: [], future: 7 });
    const layoutView = vi.fn(), drawerView = vi.fn();
    const snapshots = fileResourceStore(backend.fs);
    snapshots.subscribe(".workbench.json", layoutView);
    snapshots.subscribe(".workbench.json", drawerView);
    await Promise.all([
      commitSharedLayout(backend.fs, { version: 1, panels: { files: { open: true } } }),
      mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = ["notes.md"]; }),
    ]);
    expect(backend.latest()).toMatchObject({ pinned: ["notes.md"], layout: { panels: { files: { open: true } } }, future: 7 });
    expect(layoutView).toHaveBeenCalledTimes(2);
    expect(drawerView).toHaveBeenCalledTimes(2);
  });

  it("does not replace an unreadable or malformed configuration with an empty file", async () => {
    const backend = server({ pinned: [] });
    vi.mocked(backend.fs.read).mockRejectedValueOnce(new ResourceError("PERMISSION_DENIED", "denied"));
    await expect(mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = []; })).rejects.toThrow("denied");
    vi.mocked(backend.fs.read).mockResolvedValueOnce({ content: "{broken", version: 1 } as FileContent);
    await expect(mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = []; })).rejects.toThrow();
    expect(backend.fs.write).not.toHaveBeenCalled();
  });

  it("creates missing configuration with a create-only version", async () => {
    const backend = server({});
    vi.mocked(backend.fs.read).mockRejectedValueOnce(new ResourceError("NOT_FOUND", "missing"));
    vi.mocked(backend.fs.write).mockResolvedValueOnce({ path: ".workbench.json", version: 1 });
    await mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = ["new.md"]; });
    expect(backend.fs.write).toHaveBeenCalledWith(".workbench.json", expect.any(String), 0);
  });

  it("does not write queued or read-delayed mutations after the session changes", async () => {
    const backend = server({ pinned: [] });
    let completeRead!: (file: FileContent) => void;
    vi.mocked(backend.fs.read).mockReturnValueOnce(new Promise((resolve) => { completeRead = resolve; }));
    const first = mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = ["old.md"]; });
    const queued = mutateWorkbenchConfiguration(backend.fs, (document) => { document.bindings = {}; });
    // Attach rejection handlers before the controlled asynchronous completion.
    const results = Promise.allSettled([first, queued]);
    clearClientSessionData();
    completeRead({ path: ".workbench.json", content: "{}", version: 1, is_dir: false });
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(backend.fs.write).not.toHaveBeenCalled();
    await mutateWorkbenchConfiguration(backend.fs, (document) => { document.pinned = ["new-session.md"]; });
    expect(backend.latest().pinned).toEqual(["new-session.md"]);
  });

  it("refetches after a file signal arrives during the initial configuration read", async () => {
    const backend = server({ pinned: ["new.md"] });
    let completeRead!: (file: FileContent) => void;
    vi.mocked(backend.fs.read).mockReturnValueOnce(new Promise((resolve) => { completeRead = resolve; }));
    const initial = refreshWorkbenchConfiguration(backend.fs, 0);
    await Promise.resolve();
    const changed = refreshWorkbenchConfiguration(backend.fs, 1);
    completeRead({ path: ".workbench.json", content: JSON.stringify({ pinned: ["old.md"] }), version: 0, is_dir: false });
    await Promise.all([initial, changed]);
    expect(backend.fs.read).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fileResourceStore(backend.fs).snapshot(".workbench.json").file!.content).pinned).toEqual(["new.md"]);
  });
});
