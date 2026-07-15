import { describe, it, expect } from "vitest";
import { computeSuggestions, type ContextItem, type FileRef } from "./contextPick";

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
