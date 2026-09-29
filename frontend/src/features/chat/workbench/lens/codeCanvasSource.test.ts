import { describe, expect, it } from "vitest";
import { moveCodeCanvasCard } from "./codeCanvasSource";

describe("moveCodeCanvasCard", () => {
  it("updates one HTML/TSX card position without rewriting surrounding source", () => {
    const source = '<main data-cheers-canvas>\n  <article data-cheers-id="first" data-cheers-position="10,20">A</article>\n  <article data-cheers-id="second" data-cheers-position="30,40">B</article>\n</main>';
    expect(moveCodeCanvasCard(source, "second", 75, -5))
      .toBe(source.replace('data-cheers-position="30,40"', 'data-cheers-position="75,-5"'));
  });

  it("fails closed when a card is ambiguous or its position is computed", () => {
    const duplicate = '<div data-cheers-id="same" data-cheers-position="1,2"/><div data-cheers-id="same" data-cheers-position="3,4"/>';
    expect(moveCodeCanvasCard(duplicate, "same", 5, 6)).toBeNull();
    expect(moveCodeCanvasCard('<div data-cheers-id="card" data-cheers-position={position}/>', "card", 5, 6)).toBeNull();
    expect(moveCodeCanvasCard('<div data-cheers-id="card" data-cheers-position="1,2"/>', "card", Infinity, 6)).toBeNull();
  });

  it("keeps multiline JSX and quote style intact", () => {
    const source = `<article data-cheers-id='card'\n  data-cheers-position='1,2'\n  className="card">Value</article>`;
    expect(moveCodeCanvasCard(source, "card", 8, 9)).toBe(source.replace("'1,2'", "'8,9'"));
  });
});
