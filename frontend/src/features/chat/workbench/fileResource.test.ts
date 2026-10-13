import { describe, expect, it, vi } from "vitest";
import { createFileResourceStore, fileResourceStore } from "./fileResource";
import { makeFsClient, type FileContent } from "./fsClient";

const file = (version: number, content = `version ${version}`): FileContent => ({ path: "form.json", content, version, is_dir: false });
function setup() {
  const fs = makeFsClient(vi.fn(), "channel");
  fs.read = vi.fn();
  return { fs, store: createFileResourceStore(fs), read: vi.mocked(fs.read) };
}
describe("shared authorized file snapshots", () => {
  it("deduplicates simultaneous chat/Workbench reads and notifies both views", async () => {
    const { store, read } = setup();
    read.mockResolvedValue(file(1));
    const chat = vi.fn(), workbench = vi.fn();
    store.subscribe("form.json", chat); store.subscribe("form.json", workbench);
    const [a, b] = await Promise.all([store.read("form.json"), store.read("form.json")]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(store.snapshot("form.json").file).toBe(a);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(workbench).toHaveBeenCalledTimes(2);
  });
  it("a completed editor write cannot be overwritten by an older pending read", async () => {
    const { store, read } = setup();
    let resolve!: (value: FileContent) => void;
    read.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = store.read("form.json");
    await Promise.resolve();
    store.publish("form.json", file(2, "saved edit"));
    resolve(file(1));
    expect((await pending).version).toBe(2);
    expect(store.snapshot("form.json").file?.content).toBe("saved edit");
  });
  it("refetches when a resource signal arrives during an in-flight read", async () => {
    const { store, read } = setup();
    let resolve!: (value: FileContent) => void;
    read.mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce(file(2));
    const initial = store.refresh("form.json", 1);
    await Promise.resolve();
    const changed = store.refresh("form.json", 2);
    resolve(file(1));
    await initial; await changed;
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.snapshot("form.json").file?.version).toBe(2);
    await store.refresh("form.json", 2);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("ignores an obsolete read error after a newer editor save", async () => {
    const { store, read } = setup();
    let reject!: (error: Error) => void;
    read.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const pending = store.read("form.json");
    await Promise.resolve();
    store.publish("form.json", file(2));
    reject(new Error("old request failed"));
    expect((await pending).version).toBe(2);
    expect(store.snapshot("form.json").error).toBeUndefined();
  });
  it("removes stale content after access/deletion errors and permits an explicit retry", async () => {
    const { store, read } = setup();
    read.mockResolvedValueOnce(file(1)).mockRejectedValueOnce(new Error("permission denied")).mockResolvedValueOnce(file(2));
    await store.read("form.json");
    await expect(store.read("form.json")).rejects.toThrow("permission denied");
    expect(store.snapshot("form.json").file).toBeUndefined();
    expect(store.snapshot("form.json").loading).toBe(false);
    await store.read("form.json");
    expect(store.snapshot("form.json").file?.version).toBe(2);
  });
  it("isolates transports/accounts and exposes one store for one channel client", () => {
    const { fs } = setup();
    expect(fileResourceStore(fs)).toBe(fileResourceStore(fs));
    expect(fileResourceStore(makeFsClient(vi.fn(), "channel"))).not.toBe(fileResourceStore(fs));
  });
});
