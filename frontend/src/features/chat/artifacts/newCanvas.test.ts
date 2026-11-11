import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { parseCanvas } from "../workbench/canvas/document";
import { EMPTY_CANVAS, canvasPathFor } from "./newCanvas";

describe("new canvas", () => {
  it("files a bare name under canvases/ with the canvas suffix", () => {
    expect(canvasPathFor(" roadmap ")).toBe("canvases/roadmap.canvas.yaml");
    expect(canvasPathFor("roadmap.canvas.json")).toBe("canvases/roadmap.canvas.json");
  });

  it("keeps a folder the person typed", () => {
    expect(canvasPathFor("plans/q4")).toBe("plans/q4.canvas.yaml");
    expect(canvasPathFor("/plans/q4.canvas.yml")).toBe("plans/q4.canvas.yml");
  });

  it("refuses a name with no file in it", () => {
    expect(canvasPathFor("   ")).toBeNull();
    expect(canvasPathFor("plans/")).toBeNull();
  });

  it("starts as a canvas the canvas view accepts", () => {
    expect(parseCanvas(parse(EMPTY_CANVAS))).toMatchObject({ nodes: [], edges: [] });
  });
});
