import { describe, it, expect } from "vitest";
import {
  computeSuggestions,
  selectionLineRange,
  rangedFileContextItem,
  workspaceContextItem,
  toBundle,
  PREVIEW_MAX_CHARS,
  type ContextItem,
  type FileRef,
} from "./contextPick";

const CH = "chan-1";
const files: FileRef[] = [
  { file_id: "f1", filename: "board.json" },
  { file_id: "f2", filename: "notes.md" },
];

describe("computeSuggestions (F3)", () => {
  it("suggests the reply target", () => {
    const out = computeSuggestions(
      CH,
      { replyTo: { msg_id: "m", channel_seq: 42, sender_name: "alice" } },
      [],
      {}
    );
    expect(out.map((i) => i.id)).toEqual(["msg:42"]);
    expect(out[0].label).toBe("Reply to alice");
    expect(out[0].verb).toBe("channel.messages.by-seq");
    expect(out[0].params).toEqual({ min_seq: 42, max_seq: 42 });
  });

  it("suggests a file whose name appears in the draft", () => {
    const out = computeSuggestions(CH, { draftText: "please fix board.json", files }, [], {});
    expect(out.map((i) => i.id)).toEqual(["file:f1"]);
    expect(out[0].kind).toBe("file");
    expect(out[0].params).toEqual({ file_id: "f1" });
  });

  it("does not match short/absent filenames or unrelated text", () => {
    expect(computeSuggestions(CH, { draftText: "hello there", files }, [], {})).toEqual([]);
    // 'md' alone is below the min-length guard; only a real basename match counts.
    expect(
      computeSuggestions(CH, { draftText: "in md", files: [{ file_id: "x", filename: "md" }] }, [], {})
    ).toEqual([]);
  });

  it("suggests the plan when the draft says 'plan'", () => {
    const out = computeSuggestions(CH, { draftText: "update the plan" }, [], {});
    expect(out.map((i) => i.id)).toEqual(["plan"]);
    // but not on a substring like 'planet'
    expect(computeSuggestions(CH, { draftText: "planet earth" }, [], {})).toEqual([]);
  });

  it("drops already-picked and dismissed suggestions", () => {
    const picked: ContextItem[] = [
      { id: "plan", verb: "channel.plan.read", params: {}, label: "Plan", kind: "plan" },
    ];
    // 'plan' picked → filtered; 'board.json' dismissed → filtered.
    const out = computeSuggestions(
      CH,
      { draftText: "the plan and board.json", files },
      picked,
      { [`${CH}:file:f1`]: true }
    );
    expect(out).toEqual([]);
  });

  it("de-dups and caps the list", () => {
    const many: FileRef[] = Array.from({ length: 10 }, (_, i) => ({
      file_id: `g${i}`,
      filename: `report${i}.txt`,
    }));
    const draft = many.map((f) => f.filename).join(" ") + " plan";
    const out = computeSuggestions(
      CH,
      { replyTo: { msg_id: "m", channel_seq: 5 }, draftText: draft, files: many },
      [],
      {}
    );
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("returns nothing without a channel", () => {
    expect(computeSuggestions(undefined, { draftText: "the plan" }, [], {})).toEqual([]);
  });
});

describe("selectionLineRange (passage picking)", () => {
  const content = "line1\nline2\nline3\nline4\nline5";

  it("maps a single-line selection to its 1-indexed line", () => {
    expect(selectionLineRange(content, "line3")).toEqual({ start: 3, end: 3 });
  });

  it("maps a multi-line selection to an inclusive range", () => {
    expect(selectionLineRange(content, "line2\nline3\nline4")).toEqual({ start: 2, end: 4 });
  });

  it("normalizes CRLF", () => {
    expect(selectionLineRange(content, "line2\r\nline3")).toEqual({ start: 2, end: 3 });
  });

  it("returns null for empty or not-found selections", () => {
    expect(selectionLineRange(content, "   ")).toBeNull();
    expect(selectionLineRange(content, "nope")).toBeNull();
  });
});

describe("rangedFileContextItem", () => {
  it("builds a scoped fs.read ref with a labeled range", () => {
    const it = rangedFileContextItem("notes/plan.md", 12, 40);
    expect(it.id).toBe("file:notes/plan.md:12-40");
    expect(it.verb).toBe("fs.read");
    expect(it.params).toEqual({ path: "notes/plan.md", start_line: 12, end_line: 40 });
    expect(it.label).toBe("plan.md:12-40");
    expect(it.kind).toBe("file");
  });
});

describe("workspaceContextItem (remote workspace snapshot + locator)", () => {
  it("captures a truncated snapshot and a bot-scoped locator", () => {
    const it = workspaceContextItem({
      botId: "bot-A",
      botName: "codex",
      path: "src/main.rs",
      sessionId: "sess-1",
      content: "fn main() {}\n",
    });
    expect(it.id).toBe("ws:bot-A:src/main.rs");
    expect(it.verb).toBe("workspace.file");
    expect(it.params).toEqual({ bot_id: "bot-A", path: "src/main.rs", session_id: "sess-1" });
    expect(it.label).toBe("main.rs (@codex workspace)");
    expect(it.preview?.text).toBe("fn main() {}\n");
  });

  it("truncates the snapshot to the cap and omits an absent session", () => {
    const big = "x".repeat(PREVIEW_MAX_CHARS + 500);
    const it = workspaceContextItem({ botId: "b", path: "f.txt", content: big });
    expect(it.preview?.text.length).toBe(PREVIEW_MAX_CHARS);
    expect("session_id" in it.params).toBe(false);
    expect(it.label).toBe("f.txt (@b workspace)"); // botId fallback for name
  });
});

describe("toBundle preview passthrough", () => {
  it("carries an item's preview onto the wire bundle", () => {
    const items: ContextItem[] = [
      workspaceContextItem({ botId: "b", path: "a.md", content: "hello" }),
    ];
    const bundle = toBundle(items, "chan");
    expect(bundle?.items[0].preview?.text).toBe("hello");
    expect(bundle?.origin).toBe("human");
    expect(bundle?.items[0].params).toMatchObject({ channel_id: "chan", bot_id: "b" });
  });
});
