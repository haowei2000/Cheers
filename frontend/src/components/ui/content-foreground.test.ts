import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `text-content-subtle` was written in five places and coloured nothing: there is
// no `subtle` key in the content scale, so Tailwind emitted no rule and those
// glyphs silently inherited whatever tier their parent happened to be. A dead
// foreground class fails silently in exactly the direction that is hard to see —
// the element looks fine, just at the wrong level of the hierarchy.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = readFileSync(join(root, "tailwind.config.ts"), "utf8");

const declared = new Set(
  [...config.slice(config.indexOf("content: {")).slice(0, 400).matchAll(/"?([a-z-]+)"?:\s*"rgb\(var\(--text-/g)]
    .map((match) => match[1]),
);

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(child);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

describe("neutral foreground scale", () => {
  it("declares the documented four tiers plus the inverse pair", () => {
    expect([...declared].sort()).toEqual(
      ["muted", "on-accent", "on-light", "primary", "secondary", "strong"],
    );
  });

  it("never references a tier the scale does not define", () => {
    const dead = new Map<string, string[]>();
    for (const path of sources("src")) {
      for (const [, tier] of readFileSync(join(root, path), "utf8").matchAll(
        /\btext-content-([a-z-]+)\b/g,
      )) {
        if (declared.has(tier)) continue;
        dead.set(tier, [...(dead.get(tier) ?? []), path]);
      }
    }
    expect(Object.fromEntries(dead)).toEqual({});
  });
});
