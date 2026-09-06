import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DropdownSelect } from "./dropdown-select";

describe("DropdownSelect", () => {
  it("uses the shared selector trigger instead of a native select", () => {
    const markup = renderToStaticMarkup(
      <DropdownSelect
        label="Add scene"
        ariaLabel="Add scene"
        options={[{ value: "research", label: "Research lab" }]}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain("data-control-trigger");
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).not.toContain("<select");
  });

  it("drops the label out of an icon trigger and keeps it in the accessible name", () => {
    const markup = renderToStaticMarkup(
      <DropdownSelect
        content="icon"
        leading={<svg data-testid="scope-glyph" />}
        label="All sessions"
        ariaLabel="Scope: All sessions"
        options={[{ value: "", label: "All sessions" }]}
        onSelect={() => undefined}
      />,
    );

    // The visible text is what truncated to "Al…"; the value survives as the
    // accessible name and the tooltip instead.
    expect(markup).not.toContain(">All sessions<");
    expect(markup).toContain('aria-label="Scope: All sessions"');
    expect(markup).toContain('title="Scope: All sessions"');
    // Square ControlSize geometry, per the icon-action rule (regular = 36px).
    expect(markup).toContain("h-9 w-9");
    // No chevron: the disclosure is carried by aria-haspopup/aria-expanded.
    expect(markup).toContain('aria-expanded="false"');
    const classes = markup.match(/<button[^>]*class="([^"]*)"/)?.[1].split(/\s+/);
    expect(classes).toContain("bg-zinc-900");
    expect(classes).toContain("hover:bg-zinc-800");
    expect(classes).not.toContain("bg-control");
  });

  it("fills an icon trigger when a non-default option is chosen", () => {
    const scoped = renderToStaticMarkup(
      <DropdownSelect
        content="icon"
        active
        label="claude"
        ariaLabel="Scope: claude"
        value="s1"
        options={[{ value: "s1", label: "claude · primary" }]}
        onSelect={() => undefined}
      />,
    );

    // Without a visible label, "all" and "scoped" would look identical; the shared
    // neutral fill is the shape backup rather than a color-only cue.
    expect(scoped).toContain("data-selected");
    const classes = scoped.match(/<button[^>]*class="([^"]*)"/)?.[1].split(/\s+/);
    expect(classes).toContain("bg-control");
    expect(classes).toContain("hover:bg-control-hover");
    expect(classes).not.toContain("bg-zinc-900");
    expect(classes).not.toContain("hover:bg-zinc-800");
  });
});
