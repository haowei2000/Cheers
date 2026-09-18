import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MEANT_MOVE_PX,
  pointerTravelled,
  onDisarmHover,
  disarmHover,
  markPointerInteraction,
  clearPointerInteraction,
  isPointerFocus,
} from "./hoverIntent";

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
        if (line.includes("whenPointerMeans") || line.includes("whenPointerRests")) continue;
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

// A bubble is an answer, and the pointer only asks by coming to rest. The two
// symptoms this encodes: a tooltip that opened because a click put content under
// a cursor that never moved, and one that opened while the cursor was still on
// its way somewhere else.
describe("tooltips wait for the pointer to come to rest", () => {
  it("reads drift as the pointer staying put, and travel as moving on", () => {
    expect(pointerTravelled(null, { x: 100, y: 100 })).toBe(false);
    expect(pointerTravelled({ x: 100, y: 100 }, { x: 102, y: 101 })).toBe(false);
    expect(pointerTravelled({ x: 100, y: 100 }, { x: 100, y: 100 + MEANT_MOVE_PX })).toBe(true);
  });

  const BUBBLES = [
    "../components/ui/tip.tsx",
    "../components/ui/title-tooltip.tsx",
    "../components/ui/overflow-text.tsx",
  ];

  it("opens every bubble through the same wait and suppresses pointer clicks", () => {
    for (const path of BUBBLES) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source, path).toContain("whenPointerRests");
      // A private timer is a second, divergent answer to the same question — and
      // one that starts on arrival rather than on rest, which is the fast-popping
      // bubble itself.
      expect(source, path).not.toContain("setTimeout(() => setOpen(true)");
      // All bubble surfaces must suppress accidental tooltips on mouse / pointer clicks
      expect(source, path).toContain("isPointerFocus");
    }
  });

  it("suppresses tooltips when pointer interaction occurs", () => {
    markPointerInteraction();
    expect(isPointerFocus()).toBe(true);

    clearPointerInteraction();
    // Still within suppression window (600ms)
    expect(isPointerFocus()).toBe(true);

    // Matches non-visible focus when HTMLElement is available
    class MockHTMLElement {
      matches(selector: string) {
        return selector !== ":focus-visible";
      }
    }
    const origHtmlElement = (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement;
    (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = MockHTMLElement;
    try {
      const fakeEl = new MockHTMLElement();
      expect(isPointerFocus({ target: fakeEl } as unknown as FocusEvent)).toBe(true);
    } finally {
      (globalThis as unknown as { HTMLElement?: unknown }).HTMLElement = origHtmlElement;
    }
  });

  it("notifies listeners when hover is disarmed", () => {
    let called = 0;
    const unsub = onDisarmHover(() => {
      called++;
    });
    disarmHover();
    expect(called).toBe(1);
    unsub();
    disarmHover();
    expect(called).toBe(1);
  });
});

