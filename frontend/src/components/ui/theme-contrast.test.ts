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

it("provides stronger selected-state tokens for increased contrast", () => {
  const increased = block(/@media \(prefers-contrast: more\)\s*\{([\s\S]*?)\n\}/);
  expect(increased).toContain("--surface-selected:");
  expect(increased).toContain("--selection-indicator:");
});
