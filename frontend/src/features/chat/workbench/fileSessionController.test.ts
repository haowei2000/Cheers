import { afterEach, describe, expect, it, vi } from "vitest";
import { ResourceError } from "../hooks/useChatRealtime";
import type { FileContent, FsClient } from "./fsClient";
import { createFileSessionController, fileSessionController } from "./fileSessionController";
import { fileResourceStore } from "./fileResource";
import { clearClientSessionData } from "@/lib/clientSession";

const file = (path: string, content = "original\n", version = 1): FileContent => ({ path, content, version, is_dir: false });
function backend() {
  const fs: FsClient = {
    ls: vi.fn(), rm: vi.fn(), patch: vi.fn(),
    read: vi.fn(async (path) => file(path)),
    write: vi.fn(async (path, _content, version) => ({ path, version: (version ?? 0) + 1 })),
  };
  return fs;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
afterEach(() => { vi.useRealTimers(); });

describe("resource-owned editor drafts", () => {
  it("retains the draft and autosave when its view unmounts before the debounce finishes", async () => {
    vi.useFakeTimers();
    const fs = backend();
    const collection = fileSessionController(fs, "A.md");
    await collection.ensureLoaded();
    const unmount = collection.subscribe(vi.fn());
    collection.actions.editText("typed in Collection\n");
    unmount();
    const otherTab = fileSessionController(fs, "B.md");
    await otherTab.ensureLoaded();
    // Raw mode mounts a fresh view of the same resource before autosave.
    const raw = fileSessionController(fs, "A.md");
    expect(raw.snapshot()).toMatchObject({ text: "typed in Collection\n", dirty: true });
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.write).toHaveBeenCalledWith("A.md", "typed in Collection\n", 1);
    expect(raw.snapshot()).toMatchObject({ text: "typed in Collection\n", dirty: false, version: 2 });
    expect(otherTab.snapshot()).toMatchObject({ path: "B.md", text: "original\n", version: 1 });
  });

  it("keeps an unsaved manual draft when leaving and returning to the resource", async () => {
    const fs = backend();
    const firstView = fileSessionController(fs, "A.md", { autoSave: false });
    await firstView.ensureLoaded();
    const unmount = firstView.subscribe(vi.fn());
    firstView.actions.editText("manual draft\n");
    unmount();
    await fileSessionController(fs, "B.md").ensureLoaded();
    const returned = fileSessionController(fs, "A.md");
    await returned.ensureLoaded();
    expect(returned.snapshot()).toMatchObject({ text: "manual draft\n", dirty: true });
    expect(fs.write).not.toHaveBeenCalled();
  });

  it("a delayed save of A never changes B's buffer or write version", async () => {
    const fs = backend();
    vi.mocked(fs.read).mockImplementation(async (path) => file(path, `${path}\n`, path === "A.md" ? 1 : 20));
    const pending = deferred<{ path: string; version: number }>();
    vi.mocked(fs.write).mockReturnValueOnce(pending.promise);
    const a = fileSessionController(fs, "A.md", { autoSave: false });
    await a.ensureLoaded();
    a.actions.editText("saved A\n");
    const save = a.actions.save();
    const b = fileSessionController(fs, "B.md", { autoSave: false });
    await b.ensureLoaded();
    b.actions.editText("draft B\n");
    pending.resolve({ path: "A.md", version: 2 });
    await save;
    expect(b.snapshot()).toMatchObject({ path: "B.md", text: "draft B\n", version: 20, dirty: true });
    await b.actions.save();
    expect(fs.write).toHaveBeenLastCalledWith("B.md", "draft B\n", 20);
  });

  it("serializes writes and does not mark newer keystrokes saved by an older acknowledgment", async () => {
    const fs = backend();
    const pending = deferred<{ path: string; version: number }>();
    vi.mocked(fs.write).mockReturnValueOnce(pending.promise);
    const session = createFileSessionController(fs, "notes.md", { autoSave: false });
    await session.ensureLoaded();
    session.actions.editText("first edit\n");
    const first = session.actions.save();
    session.actions.editText("newer edit\n");
    const second = session.actions.save();
    expect(fs.write).toHaveBeenCalledTimes(1);
    pending.resolve({ path: "notes.md", version: 2 });
    await first;
    expect(session.snapshot().text).toBe("newer edit\n");
    await second;
    expect(vi.mocked(fs.write).mock.calls).toEqual([
      ["notes.md", "first edit\n", 1], ["notes.md", "newer edit\n", 2],
    ]);
    expect(session.snapshot()).toMatchObject({ text: "newer edit\n", dirty: false, version: 3 });
  });

  it("keeps newer edits dirty after the older save completes", async () => {
    const fs = backend();
    const pending = deferred<{ path: string; version: number }>();
    vi.mocked(fs.write).mockReturnValueOnce(pending.promise);
    const session = createFileSessionController(fs, "notes.md", { autoSave: false });
    await session.ensureLoaded();
    session.actions.editText("sent\n");
    const saving = session.actions.save();
    session.actions.editText("not sent yet\n");
    pending.resolve({ path: "notes.md", version: 2 });
    await saving;
    expect(session.snapshot()).toMatchObject({ text: "not sent yet\n", dirty: true, version: 2 });
    expect(session.snapshot().status).not.toBe("Saved");
  });

  it("a concurrent reload preserves the draft and autosaves its merged result", async () => {
    vi.useFakeTimers();
    const fs = backend();
    vi.mocked(fs.read).mockResolvedValueOnce(file("notes.md", "a: 1\nb: 1\n", 1));
    const session = createFileSessionController(fs, "notes.md");
    await session.ensureLoaded();
    session.actions.editText("a: 2\nb: 1\n");
    vi.mocked(fs.read).mockResolvedValueOnce(file("notes.md", "a: 1\nb: 2\n", 2));
    await session.actions.reload(true);
    expect(session.snapshot()).toMatchObject({ text: "a: 2\nb: 2\n", dirty: true, version: 2 });
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.write).toHaveBeenCalledWith("notes.md", "a: 2\nb: 2\n", 2);
  });

  it("keeps the full draft when an automatic merge retry fails", async () => {
    const fs = backend();
    const session = createFileSessionController(fs, "notes.md", { autoSave: false });
    await session.ensureLoaded();
    session.actions.editText("local draft\n");
    vi.mocked(fs.write).mockRejectedValueOnce(new ResourceError("VERSION_CONFLICT", "changed"))
      .mockRejectedValueOnce(new Error("offline"));
    vi.mocked(fs.read).mockResolvedValueOnce(file("notes.md", "original\n", 2));
    await session.actions.save();
    expect(session.snapshot()).toMatchObject({ text: "local draft\n", dirty: true, status: "offline" });
  });

  it("does not overwrite edits entered while an initial read is in flight", async () => {
    const fs = backend();
    const pending = deferred<FileContent>();
    vi.mocked(fs.read).mockReturnValueOnce(pending.promise);
    const session = createFileSessionController(fs, "notes.md", { autoSave: false });
    const loading = session.ensureLoaded();
    session.actions.editText("typed before read completed\n");
    pending.resolve(file("notes.md", "", 1));
    await loading;
    expect(session.snapshot()).toMatchObject({ text: "typed before read completed\n", dirty: true });
  });

  it("does not send an old session's delayed autosave after logout", async () => {
    vi.useFakeTimers();
    const fs = backend();
    const oldSession = fileSessionController(fs, "notes.md");
    await oldSession.ensureLoaded();
    oldSession.actions.editText("previous account's draft\n");
    clearClientSessionData();
    await vi.advanceTimersByTimeAsync(800);
    expect(fs.write).not.toHaveBeenCalled();
    expect(fileSessionController(fs, "notes.md").snapshot().text).toBe("");
  });

  it("consumes updates received while detached and revalidates the clean file on return", async () => {
    const fs = backend();
    const session = fileSessionController(fs, "notes.md");
    await session.ensureLoaded();
    const leave = session.subscribe(vi.fn());
    leave();
    fileResourceStore(fs).publish("notes.md", file("notes.md", "updated by another view\n", 2));
    session.subscribe(vi.fn());
    expect(session.snapshot()).toMatchObject({ text: "updated by another view\n", version: 2 });
    vi.mocked(fs.read).mockResolvedValueOnce(file("notes.md", "updated on server while away\n", 3));
    await session.ensureLoaded();
    expect(session.snapshot()).toMatchObject({ text: "updated on server while away\n", version: 3, dirty: false });
  });
});
