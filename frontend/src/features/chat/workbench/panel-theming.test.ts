import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The panel is the surface where dark-only recipes hurt most: it stacks glass on
// panel on canvas, so a tone picked for one theme inverts or vanishes in the other.
// `bg-zinc-900` is the panel colour, which in the light theme is pure white — a
// "raised card" written that way disappears into the panel it sits on. The tone
// scale and the surface tokens hold the SAME values, so naming the surface costs
// nothing and keeps the role legible.
const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** Plain walk rather than fs.globSync, which needs a newer Node than CI runs. */
function walk(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(child);
    return entry.name.endsWith(".tsx") ? [child] : [];
  });
}

const files = walk("src/features/chat/workbench")
  .concat([
    "src/features/chat/RemoteWorkspaceDialog.tsx",
    "src/components/ui/floating-panel.tsx",
    "src/components/ui/popover.tsx",
  ])
  .filter((path) => !path.endsWith(".test.tsx") && !path.endsWith(".preview.tsx"))
  .sort();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("panel surfaces use semantic tokens", () => {
  it("finds the panel sources it is meant to guard", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files)("%s names surfaces instead of neutral tones", (path) => {
    const source = read(path);
    // Fills and borders must name the surface. Rings are the documented exception
    // for hairlines and fields (DESIGN.md registers `ring-zinc-600`), except where
    // the ring IS a surface — a panel-coloured ring punches an element out of the
    // panel, so it has to follow the panel. zinc-100/200 are deliberate inverting
    // tints (light chip on dark, and back) and stay.
    expect(source).not.toMatch(/\b(?:[a-z-]+:)*(?:bg|border)-zinc-(?:700|800|900|950)\b/);
    expect(source).not.toMatch(/\b(?:[a-z-]+:)*ring-zinc-(?:900|950)\b/);
  });

  it.each(files)("%s leaves window elevation to the theme", (path) => {
    const source = read(path);
    expect(source).not.toMatch(/\b(?:shadow|ring)-black\b/);
  });
});
