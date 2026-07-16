import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { applyEdits } from "./yamlDoc";

// NB: single space before inline comments — Document.toString() normalizes longer runs
// (the one whitespace liberty the round-trip takes; comments themselves are kept).
const BOARD = `# sprint board (bot-maintained — keep comments!)
title: Sprint 12 # visible name

# the actual rows
rows:
  - name: alpha
    done: false
  - name: beta
    done: true

notes: keep
`;

describe("applyEdits — comment-preserving rewrite", () => {
  it("round-trips unchanged data byte-for-byte", () => {
    expect(applyEdits(BOARD, parse(BOARD))).toBe(BOARD);
  });

  it("keeps comments above and inline when a scalar changes", () => {
    const data = parse(BOARD);
    data.title = "Sprint 13";
    const out = applyEdits(BOARD, data);
    expect(out).toContain("# sprint board (bot-maintained — keep comments!)");
    expect(out).toContain("# visible name");
    expect(out).toContain("# the actual rows");
    expect(out).toContain("Sprint 13");
    expect(parse(out).title).toBe("Sprint 13");
  });

  it("keeps blank lines", () => {
    const data = parse(BOARD);
    data.notes = "changed";
    const out = applyEdits(BOARD, data);
    expect(out).toContain("\n\nnotes: changed");
  });

  it("edits nested map values in place", () => {
    const data = parse(BOARD);
    data.rows[0].done = true;
    const out = applyEdits(BOARD, data);
    expect(parse(out).rows[0].done).toBe(true);
    expect(out).toContain("# the actual rows"); // sibling comment survives
    expect(out).toContain("name: beta"); // untouched row intact
  });

  it("same-length array edits keep sibling comments", () => {
    const src = "items:\n  # first\n  - a\n  # second\n  - b\n";
    const out = applyEdits(src, { items: ["a", "c"] });
    expect(out).toContain("# first");
    expect(parse(out).items).toEqual(["a", "c"]);
  });

  it("adds and deletes keys", () => {
    const data = parse(BOARD);
    delete data.notes;
    data.owner = "wei";
    const out = applyEdits(BOARD, data);
    const round = parse(out);
    expect(round.notes).toBeUndefined();
    expect(round.owner).toBe("wei");
    expect(out).toContain("# visible name"); // unrelated comments survive
  });

  it("array push replaces the array node (documented loss) but data is correct", () => {
    const data = parse(BOARD);
    data.rows.push({ name: "gamma", done: false });
    const out = applyEdits(BOARD, data);
    expect(parse(out).rows).toHaveLength(3);
    expect(out).toContain("# sprint board (bot-maintained — keep comments!)"); // top comment survives
  });

  it("falls back to plain stringify on anchors/aliases", () => {
    const src = "base: &b { x: 1 }\nuse: *b\n";
    const out = applyEdits(src, { base: { x: 2 }, use: { x: 1 } });
    expect(parse(out)).toEqual({ base: { x: 2 }, use: { x: 1 } });
  });

  it("falls back on multi-document streams", () => {
    const src = "a: 1\n---\nb: 2\n";
    const out = applyEdits(src, { a: 3 });
    expect(parse(out)).toEqual({ a: 3 });
  });

  it("falls back on unparseable input and empty input", () => {
    expect(parse(applyEdits(": : :", { a: 1 }))).toEqual({ a: 1 });
    expect(parse(applyEdits("", { a: 1 }))).toEqual({ a: 1 });
  });

  it("replaces the root when its type changes", () => {
    const out = applyEdits("a: 1\n", [1, 2]);
    expect(parse(out)).toEqual([1, 2]);
  });

  it("a comment-only file keeps its header comments across the first save", () => {
    // a seeded board is often just "# fill me in" — contents parse to null, and the
    // first lens save used to fall into the stringify path and eat the header
    const out = applyEdits("# fill me in\n# (the bot appends rows)\n", { rows: [{ name: "a" }] });
    expect(out).toContain("# fill me in");
    expect(out).toContain("# (the bot appends rows)");
    expect(parse(out)).toEqual({ rows: [{ name: "a" }] });
  });

  it("does not refold long plain scalars it never touched", () => {
    const long = "word ".repeat(30).trim(); // 149 chars, well past the default 80-col fold
    const src = `text: ${long}\nother: 1\n`;
    const out = applyEdits(src, { text: long, other: 2 });
    expect(out).toContain(`text: ${long}\n`); // still ONE line — no lineWidth reflow
    expect(parse(out)).toEqual({ text: long, other: 2 });
  });
});
