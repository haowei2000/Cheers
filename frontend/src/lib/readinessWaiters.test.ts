import { describe, expect, it, vi } from "vitest";
import { ReadinessWaiters } from "./readinessWaiters";

describe("ReadinessWaiters", () => {
  it("removes a timed-out request without waiting for a future authentication", () => {
    const waiters = new ReadinessWaiters();
    const waiting = waiters.wait();
    expect(waiters.size).toBe(1);
    waiting.cancel();
    expect(waiters.size).toBe(0);
  });

  it("rejects and clears every waiter when its socket closes", async () => {
    const waiters = new ReadinessWaiters();
    const first = waiters.wait();
    const second = waiters.wait();
    const error = new Error("socket closed");
    const rejected = vi.fn();
    void first.promise.catch(rejected);
    void second.promise.catch(rejected);
    waiters.release(error);
    await Promise.resolve();
    expect(waiters.size).toBe(0);
    expect(rejected).toHaveBeenCalledTimes(2);
  });
});
