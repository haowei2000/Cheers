import { describe, expect, it, beforeEach } from "vitest";
import {
  zonesFor,
  fillLane,
  suggestSpawn,
  setOccupant,
  getOccupants,
  SNAP_GAP,
  LANE_TARGET,
} from "./laneSnap";

describe("zonesFor", () => {
  it("returns a single zone for a narrow short lane", () => {
    const z = zonesFor({ width: 400, height: 400 });
    expect(z).toHaveLength(1);
    expect(z[0].x).toBe(SNAP_GAP);
    expect(z[0].w).toBeCloseTo(400 - SNAP_GAP * 2);
  });

  it("stacks two rows in a narrow tall lane", () => {
    const z = zonesFor({ width: 400, height: 600 });
    expect(z).toHaveLength(2);
  });

  it("returns a 2×2 grid for a mid-size lane", () => {
    const z = zonesFor({ width: 700, height: 500 });
    expect(z).toHaveLength(4);
  });

  it("returns a 3×2 grid for a wide lane", () => {
    const z = zonesFor({ width: 1100, height: 500 });
    expect(z).toHaveLength(6);
  });
});

describe("fillLane", () => {
  it("insets by SNAP_GAP on every side", () => {
    expect(fillLane({ width: 520, height: 400 })).toEqual({
      x: SNAP_GAP,
      y: SNAP_GAP,
      w: 520 - SNAP_GAP * 2,
      h: 400 - SNAP_GAP * 2,
    });
  });
});

describe("suggestSpawn", () => {
  beforeEach(() => {
    // Clear occupant registry between cases.
    for (const key of ["a", "b", "cheers.float.workbench", "cheers.float.viewboard"]) {
      setOccupant(key, null);
    }
  });

  it("opens alone in the preferred zone instead of covering the workspace", () => {
    const bounds = { width: 600, height: 500 };
    const zones = zonesFor(bounds);
    expect(zones[0]).toMatchObject(suggestSpawn("workbench", bounds, []));
    expect(zones[zones.length - 1]).toMatchObject(
      suggestSpawn("viewboard", bounds, []),
    );
  });

  it("picks a free zone when another window occupies the lane", () => {
    const bounds = { width: 700, height: 500 };
    const zones = zonesFor(bounds);
    expect(zones.length).toBeGreaterThan(1);
    const occupied = [zones[0]];
    const placed = suggestSpawn("viewboard", bounds, occupied);
    // ViewBoard prefers the trailing cell; must not fully overlap the occupant.
    expect(placed.x !== occupied[0].x || placed.y !== occupied[0].y).toBe(true);
  });

  it("workbench prefers the leading zone among free cells", () => {
    const bounds = { width: 700, height: 500 };
    const zones = zonesFor(bounds);
    const occupied = [zones[zones.length - 1]];
    const placed = suggestSpawn("workbench", bounds, occupied);
    expect(placed).toMatchObject({ x: zones[0].x, y: zones[0].y });
  });
  it("force-splits a single-cell lane when occupied", () => {
    const bounds = { width: 400, height: 400 };
    const fill = fillLane(bounds);
    const placed = suggestSpawn("viewboard", bounds, [fill]);
    expect(placed.h).toBeLessThan(fill.h * 0.6);
    expect(placed.y).toBeGreaterThan(fill.y);
  });
});

describe("isNearlyFill", () => {
  it("detects a full-lane claim", async () => {
    const { isNearlyFill } = await import("./laneSnap");
    const bounds = { width: 600, height: 500 };
    expect(isNearlyFill(fillLane(bounds), bounds)).toBe(true);
    expect(isNearlyFill({ x: 8, y: 8, w: 100, h: 100 }, bounds)).toBe(false);
  });
});

describe("occupants registry", () => {
  beforeEach(() => setOccupant("k", null));

  it("tracks and clears occupants", () => {
    setOccupant("k", { x: 1, y: 2, w: 3, h: 4 });
    expect(getOccupants()).toEqual([{ x: 1, y: 2, w: 3, h: 4 }]);
    expect(getOccupants("k")).toEqual([]);
    setOccupant("k", null);
    expect(getOccupants()).toEqual([]);
  });
});

describe("LANE_TARGET", () => {
  it("ranks file-heavy surfaces wider than ViewBoard", () => {
    expect(LANE_TARGET.workspace).toBeGreaterThan(LANE_TARGET.workbench);
    expect(LANE_TARGET.workbench).toBeGreaterThan(LANE_TARGET.viewboard);
  });
});
