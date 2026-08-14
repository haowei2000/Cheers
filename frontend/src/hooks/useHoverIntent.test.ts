import { afterEach, describe, expect, it, vi } from "vitest";
import { createHoverIntentController } from "./useHoverIntent";

describe("hover intent controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires a deliberate dwell and keeps only a short leave grace period", () => {
    vi.useFakeTimers();
    let visible = false;
    const controller = createHoverIntentController(
      (next) => { visible = next; },
      { showDelayMs: 350, hideDelayMs: 140 },
    );

    controller.show();
    vi.advanceTimersByTime(349);
    expect(visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(visible).toBe(true);

    controller.hide();
    vi.advanceTimersByTime(139);
    expect(visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible).toBe(false);
    controller.dispose();
  });

  it("cancels a pending reveal when the pointer only passes over a row", () => {
    vi.useFakeTimers();
    let visible = false;
    const controller = createHoverIntentController(
      (next) => { visible = next; },
      { showDelayMs: 350 },
    );

    controller.show();
    vi.advanceTimersByTime(120);
    controller.hide();
    vi.runAllTimers();

    expect(visible).toBe(false);
    controller.dispose();
  });

  it("makes one message action bar replace the previous bar immediately", () => {
    let firstVisible = false;
    let secondVisible = false;
    const first = createHoverIntentController(
      (next) => { firstVisible = next; },
      { exclusiveGroup: "test-message-actions" },
    );
    const second = createHoverIntentController(
      (next) => { secondVisible = next; },
      { exclusiveGroup: "test-message-actions" },
    );

    first.showNow();
    expect(firstVisible).toBe(true);
    second.showNow();

    expect(firstVisible).toBe(false);
    expect(secondVisible).toBe(true);
    first.dispose();
    second.dispose();
  });
});
