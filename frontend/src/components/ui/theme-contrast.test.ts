import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Rgb = [number, number, number];

const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");

function block(pattern: RegExp): string {
  const match = css.match(pattern);
  if (!match?.[1]) throw new Error(`Theme block not found: ${pattern}`);
  return match[1];
}

const dark = block(/:root\s*\{([\s\S]*?)\n\}/);
const light = block(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/);

function token(source: string, name: string): Rgb {
  const match = source.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+);`));
  if (!match) throw new Error(`Missing --${name}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(rgb: Rgb): number {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first: Rgb, second: Rgb): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe.each([
  ["dark", dark],
  ["light", light],
])("%s appearance contrast", (_appearance, source) => {
  it("keeps every neutral text tier readable on the canvas", () => {
    const canvas = token(source, "surface-canvas");
    expect(contrast(token(source, "text-primary"), canvas)).toBeGreaterThanOrEqual(7);
    expect(contrast(token(source, "text-secondary"), canvas)).toBeGreaterThanOrEqual(7);
    expect(contrast(token(source, "text-muted"), canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps selected text readable through hover and active states", () => {
    const text = token(source, "text-primary");
    for (const state of ["surface-selected", "surface-selected-hover", "surface-selected-active"]) {
      expect(contrast(text, token(source, state))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives the non-color selected marker at least 3:1 contrast", () => {
    expect(
      contrast(token(source, "selection-indicator"), token(source, "surface-selected")),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe.each([
  ["dark", dark],
  ["light", light],
])("%s appearance foreground ladder", (_appearance, source) => {
  // The Settings surfaces are cards on --surface-panel, not on the canvas, and in
  // the light theme that panel is pure white — the tier the canvas test passes on
  // is not automatically the tier the reader actually sees.
  it("keeps every neutral text tier readable on the panel surface", () => {
    const panel = token(source, "surface-panel");
    expect(contrast(token(source, "text-strong"), panel)).toBeGreaterThanOrEqual(7);
    expect(contrast(token(source, "text-primary"), panel)).toBeGreaterThanOrEqual(7);
    expect(contrast(token(source, "text-secondary"), panel)).toBeGreaterThanOrEqual(7);
    expect(contrast(token(source, "text-muted"), panel)).toBeGreaterThanOrEqual(4.5);
  });

  // A page whose every tier sits in the same narrow band reads as one flat grey
  // wash even when each tier passes AA on its own. Hierarchy needs visible steps
  // AND an anchor near the top of the range.
  it("separates the tiers into a ladder with a strong anchor", () => {
    const panel = token(source, "surface-panel");
    const strong = contrast(token(source, "text-strong"), panel);
    const primary = contrast(token(source, "text-primary"), panel);
    const secondary = contrast(token(source, "text-secondary"), panel);
    const muted = contrast(token(source, "text-muted"), panel);

    expect(strong).toBeGreaterThan(primary);
    expect(primary).toBeGreaterThan(secondary);
    expect(secondary).toBeGreaterThan(muted);
    // The top of the ladder has to be genuinely dark/bright, not merely "AA".
    expect(strong).toBeGreaterThanOrEqual(12);
    // And the span from anchor to floor has to be wide enough to read as rank.
    expect(strong / muted).toBeGreaterThanOrEqual(1.8);
  });

  // Floating chrome is a material laid over the panel. Tinting it with the panel's
  // own colour makes it vanish — which is exactly what a white glass token did on
  // a white light-theme panel.
  it("gives floating glass a tone distinct from the panel behind it", () => {
    const glass = token(source, "surface-glass");
    const panel = token(source, "surface-panel");
    expect(glass).not.toEqual(panel);
    expect(contrast(glass, panel)).toBeGreaterThanOrEqual(1.12);
  });
});

it("provides stronger selected-state tokens for increased contrast", () => {
  const increased = block(/@media \(prefers-contrast: more\)\s*\{([\s\S]*?)\n\}/);
  expect(increased).toContain("--surface-selected:");
  expect(increased).toContain("--selection-indicator:");
});
