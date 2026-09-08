import { describe, expect, it } from "vitest";
import { ResourceError } from "../hooks/useChatRealtime";
import type { FsClient } from "./fsClient";
import type { PatchOp } from "./patchOps";
import {
  adoptText,
  formatFor,
  canEditData,
  canPatch,
  editData,
  editText,
  emptyBuffer,
  patchData,
  patchWithVersionCheck,
  type FileBuffer,
} from "./jsonFile";

const YAML = "canvas.yaml";
const loaded = (path: string, content: string): FileBuffer =>
  adoptText(path, emptyBuffer(path), content);

describe("one buffer, two views", () => {
  it("keeps text as the truth and derives data from it", () => {
    // The Raw view and the Preview view are the same buffer. Before this they were two
    // sessions over one file, and an unsaved edit in one was invisible to the other.
    const buffer = editText(YAML, loaded(YAML, "a: 1\n"), "a: 2\n");
    expect(buffer.text).toBe("a: 2\n");
    expect(buffer.data).toEqual({ a: 2 });
    expect(buffer.dirty).toBe(true);
  });

  it("serializes a lens edit back into the text, comments intact", () => {
    // The other direction. YAML round-trips through the CST patch, which is the whole
    // reason `text` is the truth rather than a render of `data`.
    const buffer = editData(YAML, loaded(YAML, "# why this matters\na: 1\n"), { a: 2 });
    expect(buffer.text).toContain("# why this matters");
    expect(buffer.text).toContain("a: 2");
    expect(buffer.parsedText).toBe(buffer.text);
    expect(buffer.dirty).toBe(true);
  });

  it("marks the buffer clean when the server's content is adopted", () => {
    expect(adoptText(YAML, editText(YAML, emptyBuffer(YAML), "a: 1\n"), "a: 9\n")).toMatchObject({
      text: "a: 9\n",
      data: { a: 9 },
      dirty: false,
    });
  });

  it("treats an absent or empty file as empty, not as a parse failure", () => {
    expect(emptyBuffer(YAML).data).toBeNull();
    expect(emptyBuffer("notes.md").data).toBe("");
    expect(adoptText(YAML, emptyBuffer(YAML), "").parseError).toBeNull();
  });
});

describe("a parse failure", () => {
  const broken = editText(YAML, loaded(YAML, "a: 1\n"), "a: 1\n  b: [");

  it("holds the last text that parsed instead of blanking the preview", () => {
    // Half-typed YAML is invalid for most of the time you spend typing it.
    expect(broken.parseError).not.toBeNull();
    expect(broken.data).toEqual({ a: 1 });
    expect(broken.parsedText).toBe("a: 1\n");
    expect(broken.text).toBe("a: 1\n  b: [");
  });

  it("closes the write path, which is the half that protects the text", () => {
    // Serializing the stale `data` back would overwrite the half-typed text with a
    // document one edit old — losing exactly what is being typed.
    expect(canEditData(broken)).toBe(false);
    expect(canPatch(broken)).toBe(false);
  });

  it("recovers as soon as the text parses again", () => {
    const fixed = editText(YAML, broken, "a: 1\nb: 2\n");
    expect(fixed.parseError).toBeNull();
    expect(fixed.data).toEqual({ a: 1, b: 2 });
    expect(canEditData(fixed)).toBe(true);
  });

  it("survives a bot writing something malformed, without hiding it", () => {
    // A malformed file is precisely the one you need Raw for, so the text is adopted
    // even though it does not parse.
    const pushed = adoptText(YAML, loaded(YAML, "a: 1\n"), "a: [");
    expect(pushed.text).toBe("a: [");
    expect(pushed.parseError).not.toBeNull();
    expect(pushed.dirty).toBe(false);
  });
});

describe("structured edits", () => {
  it("moves data optimistically and leaves the text for the server to resolve", () => {
    // fs.patch answers with a version, not content; the reload after it brings back the
    // bytes the SERVER wrote, comments included — which a local re-serialize would lose.
    const base = loaded(YAML, "# keep me\nnodes:\n  - id: a\n");
    const patched = patchData(base, [{ op: "set", path: ["nodes", 0, "id"], value: "b" }]);
    expect(patched.data).toEqual({ nodes: [{ id: "b" }] });
    expect(patched.text).toBe(base.text);
  });

  it("refuses to patch over unsaved text", () => {
    // The op is addressed against the SERVER's document. With unsaved text the server
    // holds something else, so the patch would land in a document the user is not
    // looking at — and the next Save would conflict against the version it bumped.
    const typed = editText(YAML, loaded(YAML, "nodes: []\n"), "nodes: [1]\n");
    expect(typed.dirty).toBe(true);
    expect(canPatch(typed)).toBe(false);
    expect(canEditData(typed)).toBe(true); // a whole-document write is still coherent
  });
});

describe("renderer matching", () => {
  // A renderer is chosen by running `acceptsData` over the file's content, and then
  // handed the file's data. Those used to come from two different buffers — Raw's
  // unsaved text and the preview's own `fs.read` — so the panel could offer a renderer
  // the preview was unable to feed. `parsedText` is the fix: it is always the text
  // `data` was parsed from, so matching and rendering cannot disagree.
  const paired = (buffer: FileBuffer) =>
    expect(formatFor(YAML).parse(buffer.parsedText)).toEqual(buffer.data);

  it("pairs the matched text with the rendered data while the text parses", () => {
    const canvas = loaded(YAML, "canvas: 1\nnodes: []\n");
    expect(canvas.parsedText).toBe(canvas.text);
    paired(canvas);
    paired(editText(YAML, canvas, "canvas: 1\nnodes: [{id: a}]\n"));
  });

  it("keeps them paired when the text stops parsing — both go one edit behind", () => {
    const canvas = loaded(YAML, "canvas: 1\nnodes: []\n");
    const broken = editText(YAML, canvas, "canvas: 1\nnodes: [");
    expect(broken.parsedText).toBe(canvas.text);
    paired(broken);
  });

  it("follows the buffer down to empty rather than holding a document that is gone", () => {
    // "" parses (to null); it is a document the user emptied, not a syntax error. So
    // Preview correctly stops matching — the honest answer, and reversible with undo.
    const cleared = editText(YAML, loaded(YAML, "canvas: 1\nnodes: []\n"), "");
    expect(cleared.parseError).toBeNull();
    expect(cleared.parsedText).toBe("");
    paired(cleared);
  });
});

describe("structured edit conflict recovery", () => {
  it("never replays index-addressed ops after fs.patch conflicts", async () => {
    const patchCalls: { path: string; ops: readonly PatchOp[]; ifVersion: number }[] = [];
    let readCount = 0;

    const mockFs: FsClient = {
      ls: async () => ({ path: "", entries: [] }),
      rm: async () => undefined,
      write: async () => ({ path: "canvas.yaml", version: 1 }),
      read: async (p: string) => {
        readCount++;
        return {
          path: p,
          content: "canvas: 1\nnodes:\n  - id: a\n",
          version: 2,
          is_dir: false,
        };
      },
      patch: async (p: string, ops: readonly PatchOp[], ifVersion: number) => {
        patchCalls.push({ path: p, ops, ifVersion });
        throw new ResourceError("VERSION_CONFLICT", "version conflict");
      },
    };

    const ops: PatchOp[] = [{ op: "set", path: ["nodes", 0, "id"], value: "b" }];
    await expect(patchWithVersionCheck(mockFs, "canvas.yaml", ops, 1)).rejects.toThrow("version conflict");

    // A fresh array may no longer have the same object at index 0. The session reloads
    // outside this helper, but the stale intent is never issued against its new version.
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].ifVersion).toBe(1);
    expect(patchCalls[0].ops).toEqual(ops);
    expect(readCount).toBe(0);
  });

  it("rethrows non-conflict errors without retrying", async () => {
    const mockFs: FsClient = {
      ls: async () => ({ path: "", entries: [] }),
      rm: async () => undefined,
      write: async () => ({ path: "canvas.yaml", version: 1 }),
      read: async () => ({ path: "canvas.yaml", content: "", version: 1, is_dir: false }),
      patch: async () => {
        throw new ResourceError("PERMISSION_DENIED", "permission denied");
      },
    };

    const ops: PatchOp[] = [{ op: "set", path: ["nodes", 0, "id"], value: "b" }];
    await expect(patchWithVersionCheck(mockFs, "canvas.yaml", ops, 1)).rejects.toThrow("permission denied");
  });
});
