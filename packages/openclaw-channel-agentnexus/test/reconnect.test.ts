import { describe, expect, it } from "vitest";

import { computeBackoff, isFatalCloseCode } from "../src/reconnect.js";
import { WS_CLOSE_AUTH_FAIL, WS_CLOSE_BOT_UNAVAILABLE, WS_CLOSE_SUPERSEDED } from "../src/types.js";

describe("computeBackoff", () => {
  const opts = { baseMs: 1000, maxMs: 30000, resetAfterMs: 30000 };

  it("grows exponentially and respects cap", () => {
    // attempt=1: base * 1 = 1000, jittered 500-1000
    for (let i = 0; i < 20; i++) {
      const v = computeBackoff(1, opts);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
    // attempt=5: base * 16 = 16000, jittered 8000-16000
    for (let i = 0; i < 20; i++) {
      const v = computeBackoff(5, opts);
      expect(v).toBeGreaterThanOrEqual(8000);
      expect(v).toBeLessThanOrEqual(16000);
    }
    // attempt=10: would be 512000, capped at 30000, jittered 15000-30000
    for (let i = 0; i < 20; i++) {
      const v = computeBackoff(10, opts);
      expect(v).toBeGreaterThanOrEqual(15000);
      expect(v).toBeLessThanOrEqual(30000);
    }
  });

  it("attempt 0 falls back to base*1", () => {
    for (let i = 0; i < 10; i++) {
      const v = computeBackoff(0, opts);
      expect(v).toBeGreaterThanOrEqual(500);
      expect(v).toBeLessThanOrEqual(1000);
    }
  });
});

describe("isFatalCloseCode", () => {
  it("flags auth fail, bot-unavailable, and supersede as fatal", () => {
    // 4402 supersede is fatal because this old connection was kicked off; reconnecting would ping-pong.
    expect(isFatalCloseCode(WS_CLOSE_AUTH_FAIL)).toBe(true);
    expect(isFatalCloseCode(WS_CLOSE_BOT_UNAVAILABLE)).toBe(true);
    expect(isFatalCloseCode(WS_CLOSE_SUPERSEDED)).toBe(true);
  });

  it("does NOT flag standard close codes as fatal", () => {
    expect(isFatalCloseCode(1000)).toBe(false);
    expect(isFatalCloseCode(1011)).toBe(false);
    expect(isFatalCloseCode(1006)).toBe(false);
  });
});
