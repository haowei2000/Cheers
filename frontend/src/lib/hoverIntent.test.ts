import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `:hover` is positional, not event-driven: it starts matching the instant content
// mounts under a stationary cursor, and no pointer event arrives to clear it. The
// guard that holds hover back until the pointer moves only works if EVERY hover
// rule carries it — one ungated rule is one page that still opens pre-lit.
const config = readFileSync(new URL("../../tailwind.config.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

const GUARD = ":not(:where([data-pointer-idle] *))";

describe("hover is gated on pointer intent", () => {
  it("gates the hover variant every utility compiles through", () => {
    expect(config).toContain(`addVariant("hover", \`&:hover\${idle}\`)`);
    expect(config).toContain(`const idle = "${GUARD}"`);
  });

  // The regression this catches is silent and severe: overriding group-hover with a
  // plain addVariant drops Tailwind's named-group rewriting, so `group-hover/item`
  // compiles down to a bare `.group` and fires for whichever group is nearest —
  // hovering a row would reveal the panel's chrome. Only the modifier form keeps it.
  it("keeps named groups keyed to their own group", () => {
    expect(config).toContain("matchVariant(");
    expect(config).toMatch(/matchVariant\(\s*"group-hover"/);
    expect(config).toContain("modifier");
  });

  it("gates the hand-written hover rules too", () => {
    const ungated = [...css.matchAll(/^([^\n{]*:hover[^\n{]*)\{/gm)]
      .map((match) => match[1].trim())
      // A scrollbar thumb cannot be mistaken for the thing you meant to point at.
      .filter((selector) => !selector.startsWith("::-webkit-scrollbar"))
      .filter((selector) => !selector.includes("data-pointer-idle"));
    expect(ungated).toEqual([]);
  });
});

// The CSS guard only covers `hover:` utilities. JS hover handlers are a second,
// independent path to the same symptom: `mouseenter` and `pointerover` fire when the
// element under the cursor changes, and a page arriving under a still cursor changes
// it exactly as an approach does. That is what pops the back button's tooltip open
// when Settings opens beneath the pointer.
const root = fileURLToPath(new URL("../", import.meta.url));

// Keeping an already-open surface alive is not opening one. The message action bar
// can only be under the pointer because the message's own reveal fired — which is
// gated — so gating this too would stop the bar surviving the gap to reach it.
const KEEPS_OPEN = new Set([
  "features/chat/MessageItem.tsx:onMouseEnter={onEnter}",
  "components/ui/floating-layer.tsx:onMouseEnter={onMouseEnter}",
]);

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(child);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

describe("JS hover handlers wait for the same evidence", () => {
  it("opens nothing on a hover the pointer never asked for", () => {
    const ungated: string[] = [];
    for (const path of sources("components").concat(sources("features"), sources("hooks"))) {
      const source = readFileSync(join(root, path), "utf8");
      for (const [line] of source.matchAll(/onMouseEnter=\{[^}]*\}|onPointerEnter=\{[^}]*\}/g)) {
        if (line.includes("whenPointerMeans")) continue;
        // Prop plumbing and declarations, not a handler that opens anything.
        if (/^on(Mouse|Pointer)Enter=\{on(Mouse|Pointer)Enter\}$/.test(line)) {
          if (KEEPS_OPEN.has(`${path}:${line}`)) continue;
        }
        if (KEEPS_OPEN.has(`${path}:${line}`)) continue;
        ungated.push(`${path}: ${line}`);
      }
    }
    expect(ungated).toEqual([]);
  });
});
