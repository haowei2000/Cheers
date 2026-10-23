import { describe, expect, it } from "vitest";
import { discoveryRefetchInterval } from "./agentOptionsDiscovery";

describe("agent option discovery retries", () => {
  it("backs off for roughly 90 seconds and then stops polling an empty vocabulary", () => {
    const delays = Array.from({ length: 20 }, (_, index) => discoveryRefetchInterval(index + 1, 0, true));
    const scheduled = delays.filter((delay): delay is number => delay !== false);
    expect(scheduled).toHaveLength(6);
    const retryWindow = scheduled.reduce((sum, delay) => sum + delay, 0);
    expect(retryWindow).toBeGreaterThanOrEqual(60_000);
    expect(retryWindow).toBeLessThanOrEqual(120_000);
    expect(scheduled).toEqual([...scheduled].sort((a, b) => a - b));
    expect(delays.slice(6).every(delay => delay === false)).toBe(true);
  });
  it("stops on discovered options or a failed request and gives a newly mounted reader its retry window", () => {
    expect(discoveryRefetchInterval(1, 0, false)).toBe(false);
    expect(discoveryRefetchInterval(1, 1, true)).toBe(false);
    expect(discoveryRefetchInterval(21, 0, true, 20)).toBe(3_000);
  });
});
