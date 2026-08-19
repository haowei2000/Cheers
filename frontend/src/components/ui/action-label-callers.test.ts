import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `Button content="iconText"` renders the registered ActionKey label and drops
 * every child after the icon. A call site that passes both therefore ships copy
 * that never appears on screen — that is how a Forward button rendered as
 * "Send" and a back control rendered as "Start".
 *
 * The Button primitive throws on this in dev, but only when the branch actually
 * renders, so a rarely-visited dialog can carry the mistake for months. This
 * scans the source instead. It matches the aliased import too: 52 files bring
 * the primitive in as `UiButton`, and an earlier version of this sweep that
 * only looked for `<Button` missed every one of them.
 */

const srcRoot = path.resolve(import.meta.dirname, "../..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/** Index of the `>` closing a JSX open tag, skipping strings and nested braces. */
function openTagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const char = source[i]!;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (char === ">" && depth === 0) return i;
  }
  return -1;
}

/** Drop the leading icon element so only trailing content is left. */
function afterLeadingElement(body: string): string {
  let current = body;
  for (;;) {
    let next = current.replace(/^\s*<([A-Za-z][\w.]*)\b[^>]*?\/>\s*/s, "");
    const paired = /^\s*<([A-Za-z][\w.]*)\b/.exec(next);
    if (paired) {
      const closing = `</${paired[1]}>`;
      const at = next.indexOf(closing);
      if (at >= 0) next = next.slice(at + closing.length);
    }
    if (next === current) return current;
    current = next;
  }
}

describe("iconText button call sites", () => {
  it("never pass a label the ActionKey registry will discard", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(srcRoot)) {
      // This file's own fixtures assert the throwing behaviour on purpose.
      if (file.endsWith("control-geometry.test.tsx")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<(Button|UiButton)\b/g)) {
        const start = match.index!;
        const end = openTagEnd(source, start + match[0].length);
        if (end < 0) continue;
        const tag = source.slice(start, end + 1);
        if (!tag.includes('content="iconText"') || !tag.includes("action=")) continue;
        if (tag.trimEnd().endsWith("/>")) continue;
        const close = source.indexOf(`</${match[1]}>`, end);
        if (close < 0) continue;
        const trailing = afterLeadingElement(source.slice(end + 1, close)).trim();
        // A lone `{expr}` is the icon itself (e.g. a ternary between two icons).
        if (!trailing || /^\{[\s\S]*\}$/.test(trailing)) continue;
        const line = source.slice(0, start).split("\n").length;
        offenders.push(
          `${path.relative(srcRoot, file)}:${line} discards ${JSON.stringify(
            trailing.replace(/\s+/g, " ").slice(0, 60),
          )}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
