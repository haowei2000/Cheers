import { readFileSync } from "node:fs";
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
