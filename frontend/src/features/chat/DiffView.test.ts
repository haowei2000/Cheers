import { describe, it, expect } from "vitest";
import { parseSections } from "./DiffView";

/**
 * These fixtures are REAL output from the ACP connector's
 * `tool_call_unified_diff` (verbatim, including the `a//abs/path` prefix that
 * results from git's `a/` convention meeting an absolute path). They guard the
 * seam between the two: the connector emits, this parser consumes.
 */
const CONNECTOR_EDIT_DIFF = `diff --git a//work/big.ts b//work/big.ts
--- a//work/big.ts
+++ b//work/big.ts
@@ -1,4 +1,4 @@
-const MARKER = "before";
+const MARKER = "after";
 export function helper0(input: string): string { return input.trim() + "0"; }
 export function helper1(input: string): string { return input.trim() + "1"; }
 export function helper2(input: string): string { return input.trim() + "2"; }
`;

describe("parseSections on connector-emitted approval diffs", () => {
  it("renders an absolute path as one section with the real path as its title", () => {
    const sections = parseSections(CONNECTOR_EDIT_DIFF);
    expect(sections).toHaveLength(1);
    // The `a/` prefix must be stripped back off, leaving the absolute path.
    expect(sections[0].title).toBe("/work/big.ts");
    expect(sections[0].adds).toBe(1);
    expect(sections[0].dels).toBe(1);
  });

  it("keeps line numbers anchored to the hunk header", () => {
    const [section] = parseSections(CONNECTOR_EDIT_DIFF);
    const del = section.lines.find((l) => l.kind === "del");
    const add = section.lines.find((l) => l.kind === "add");
    expect(del?.text).toBe('-const MARKER = "before";');
    expect(del?.oldNo).toBe(1);
    expect(add?.text).toBe('+const MARKER = "after";');
    expect(add?.newNo).toBe(1);
    // Context after the change continues from the hunk start.
    const ctx = section.lines.filter((l) => l.kind === "ctx");
    expect(ctx[0].oldNo).toBe(2);
    expect(ctx[0].newNo).toBe(2);
  });

  it("splits a multi-file approval diff into one section per file", () => {
    const multi = `diff --git a//work/a.rs b//work/a.rs
--- a//work/a.rs
+++ b//work/a.rs
@@ -1 +1 @@
-a
+A
diff --git a//work/b.rs b//work/b.rs
--- a//work/b.rs
+++ b//work/b.rs
@@ -1 +1 @@
-b
+B
`;
    const sections = parseSections(multi);
    expect(sections.map((s) => s.title)).toEqual(["/work/a.rs", "/work/b.rs"]);
    expect(sections.every((s) => s.adds === 1 && s.dels === 1)).toBe(true);
  });

  it("renders the truncation marker as a plain line, not a bogus diff row", () => {
    const truncated = `diff --git a//work/new.ts b//work/new.ts
--- a//work/new.ts
+++ b//work/new.ts
@@ -0,0 +1,2 @@
+brand new line 0
… diff truncated — approve only if you trust the paths above
`;
    const [section] = parseSections(truncated);
    expect(section.adds).toBe(1);
    // The marker must not be miscounted as an addition or deletion.
    expect(section.dels).toBe(0);
    expect(section.lines.some((l) => l.text.includes("diff truncated"))).toBe(true);
  });
});
