import { describe, expect, it, vi } from "vitest";
import { clearClientSessionData } from "@/lib/clientSession";
import { resolveDeskResource } from "@/api/resources";
import { channelFileClient, resolveWorkbenchTarget, workbenchFileClient } from "./channelFileClient";
import { fileSessionController } from "./fileSessionController";

vi.mock("@/api/resources", () => ({ resolveDeskResource: vi.fn() }));
const URI = "cheers:resource/00000000-0000-0000-0000-000000000001/desk/00000000-0000-0000-0000-000000000002";
function transport() {
  return vi.fn(async (verb: string, params: Record<string, unknown>) => {
    if (verb === "fs.read") return { path: params.path, content: "current content\n", version: 4, is_dir: false };
    return { path: params.path, version: 5 };
  });
}

describe("channel resource identity", () => {
  it("restores the same manual draft across channel A → B → A", async () => {
    const send = transport();
    const a = channelFileClient(send, "A");
    const draft = fileSessionController(a, "notes.md", { autoSave: false });
    await draft.ensureLoaded();
    draft.actions.editText("manual draft in A\n");
    const b = channelFileClient(send, "B");
    await fileSessionController(b, "notes.md").ensureLoaded();
    const returned = channelFileClient(send, "A");
    expect(returned).toBe(a);
    expect(fileSessionController(returned, "notes.md").snapshot()).toMatchObject({ text: "manual draft in A\n", dirty: true });
    expect(fileSessionController(b, "notes.md").snapshot().text).toBe("current content\n");
  });

  it("current global URIs and path navigation use the same draft; historical revisions remain separate and read-only", async () => {
    const send = transport();
    const current = channelFileClient(send, "A");
    expect(workbenchFileClient(send, "A", URI)).toBe(current);
    expect(workbenchFileClient(send, "A", "cheers:desk/notes.md")).toBe(current);
    const draft = fileSessionController(current, "notes.md", { autoSave: false });
    await draft.ensureLoaded();
    draft.actions.editText("current manual draft\n");
    vi.mocked(resolveDeskResource).mockResolvedValue({ kind: "desk", uri: `${URI}?v=1`, resource_id: "resource", service_id: "service", channel_id: "A", path: "notes.md",
      content: "historical content\n", version: 1, latest_version: 4, is_dir: false, deleted: false });
    const historical = workbenchFileClient(send, "A", `${URI}?v=1`);
    expect(historical).not.toBe(current);
    const oldVersion = fileSessionController(historical, "notes.md", { autoSave: false });
    await oldVersion.ensureLoaded();
    expect(oldVersion.snapshot()).toMatchObject({ text: "historical content\n", version: 1 });
    await expect(historical.write("notes.md", "replacement", 1)).rejects.toThrow("read-only");
    expect(fileSessionController(workbenchFileClient(send, "A", URI), "notes.md").snapshot()).toMatchObject({ text: "current manual draft\n", dirty: true, version: 4 });
  });

  it("evicts inactive channel clients while retaining unsaved resources", async () => {
    const send = transport();
    const inactive = channelFileClient(send, "inactive");
    const a = channelFileClient(send, "A");
    const draft = fileSessionController(a, "notes.md", { autoSave: false });
    await draft.ensureLoaded();
    draft.actions.editText("keep this draft\n");
    for (let index = 0; index < 40; index++) channelFileClient(send, `other-${index}`);
    expect(channelFileClient(send, "inactive")).not.toBe(inactive);
    expect(channelFileClient(send, "A")).toBe(a);
    expect(fileSessionController(a, "notes.md").snapshot().text).toBe("keep this draft\n");
  });

  it("isolates authenticated sessions and prevents old client operations after logout", async () => {
    const send = transport();
    const old = channelFileClient(send, "A");
    const draft = fileSessionController(old, "notes.md", { autoSave: false });
    await draft.ensureLoaded();
    draft.actions.editText("private draft\n");
    clearClientSessionData();
    await expect(old.write("notes.md", "wrong account", 4)).rejects.toThrow("session changed");
    const current = channelFileClient(send, "A");
    expect(current).not.toBe(old);
    expect(fileSessionController(current, "notes.md").snapshot().text).toBe("");
  });

  it("refuses a global target from another channel even when its path matches a local file", async () => {
    const send = transport();
    vi.mocked(resolveDeskResource).mockResolvedValue({ kind: "desk", uri: URI, resource_id: "resource", service_id: "service", channel_id: "other-channel", path: "notes.md",
      content: "other channel content\n", version: 1, latest_version: 4, is_dir: false, deleted: false });
    await expect(resolveWorkbenchTarget(URI, "A")).rejects.toThrow("another channel");
    expect(resolveDeskResource).toHaveBeenLastCalledWith(URI, "A");
    await expect(workbenchFileClient(send, "A", `${URI}?v=1`).read("notes.md")).rejects.toThrow("another channel");
    expect(send).not.toHaveBeenCalled();
  });
});
