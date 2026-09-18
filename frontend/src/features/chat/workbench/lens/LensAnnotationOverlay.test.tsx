import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { computeMarkerPosition, LensAnnotationOverlay } from "./LensAnnotationOverlay";
import type { Annotation } from "../annotations";

const mockNotes: Annotation[] = [
  {
    id: "note-1",
    at: 0,
    path: "data.json",
    anchor: { kind: "path", sourcePath: [0] },
    label: "Row 1",
    note: "First row remark",
  },
];

const containerRect = {
  top: 0,
  left: 0,
  right: 800,
  bottom: 600,
  width: 800,
  height: 600,
};

describe("LensAnnotationOverlay", () => {
  it("renders null on initial/SSR render when container is not mounted", () => {
    const markup = renderToStaticMarkup(
      <LensAnnotationOverlay
        containerRef={{ current: null }}
        notes={mockNotes}
        activeAnnotationId="note-1"
      />
    );
    expect(markup).toBe("");
  });

  describe("computeMarkerPosition", () => {
    it("positions markers beside compact elements centered vertically", () => {
      const elRect = { top: 100, bottom: 140, left: 50, right: 250, width: 200, height: 40 };
      const pos = computeMarkerPosition(elRect, containerRect);
      expect(pos).not.toBeNull();
      // top: 100 + (40 - 24) / 2 = 108
      expect(pos!.top).toBe(108);
      // left: 250 - 28 = 222
      expect(pos!.left).toBe(222);
    });

    it("positions markers near top for tall elements rather than centering", () => {
      const elRect = { top: 100, bottom: 400, left: 50, right: 350, width: 300, height: 300 };
      const pos = computeMarkerPosition(elRect, containerRect);
      expect(pos).not.toBeNull();
      // top: 100 + 6 = 106 (anchored near top of tall section)
      expect(pos!.top).toBe(106);
      expect(pos!.left).toBe(322);
    });

    it("positions table row markers immediately before the action column", () => {
      const elRect = { top: 80, bottom: 116, left: 8, right: 792, width: 784, height: 36 };
      const lastCellRect = { left: 760, right: 792 };
      const pos = computeMarkerPosition(elRect, containerRect, {
        isTableRow: true,
        lastCellRect,
      });
      expect(pos).not.toBeNull();
      // left: 760 - 28 = 732 (sits cleanly before delete cell)
      expect(pos!.left).toBe(732);
      expect(pos!.top).toBe(86);
    });

    it("offsets multiple notes on the same target element so they do not overlap", () => {
      const elRect = { top: 100, bottom: 140, left: 50, right: 250, width: 200, height: 40 };
      const pos0 = computeMarkerPosition(elRect, containerRect, { noteIndexOnTarget: 0 });
      const pos1 = computeMarkerPosition(elRect, containerRect, { noteIndexOnTarget: 1 });
      const pos2 = computeMarkerPosition(elRect, containerRect, { noteIndexOnTarget: 2 });

      expect(pos0!.left).toBe(222);
      expect(pos1!.left).toBe(196);
      expect(pos2!.left).toBe(170);
    });

    it("returns null when element is scrolled out of view vertically or horizontally", () => {
      // Scrolled off top
      expect(
        computeMarkerPosition(
          { top: -100, bottom: -10, left: 50, right: 250, width: 200, height: 90 },
          containerRect
        )
      ).toBeNull();

      // Scrolled off bottom
      expect(
        computeMarkerPosition(
          { top: 610, bottom: 700, left: 50, right: 250, width: 200, height: 90 },
          containerRect
        )
      ).toBeNull();

      // Scrolled off left
      expect(
        computeMarkerPosition(
          { top: 50, bottom: 90, left: -300, right: -10, width: 290, height: 40 },
          containerRect
        )
      ).toBeNull();

      // Scrolled off right
      expect(
        computeMarkerPosition(
          { top: 50, bottom: 90, left: 810, right: 1000, width: 190, height: 40 },
          containerRect
        )
      ).toBeNull();
    });

    it("clamps position to stay within container boundaries", () => {
      // Element at very bottom right
      const elRect = { top: 580, bottom: 620, left: 700, right: 900, width: 200, height: 40 };
      const pos = computeMarkerPosition(elRect, containerRect);
      expect(pos).not.toBeNull();
      // Clamped to containerRect.height - 28 = 572
      expect(pos!.top).toBe(572);
      // Clamped to containerRect.width - 28 = 772
      expect(pos!.left).toBe(772);
    });
  });
});
