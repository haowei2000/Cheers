import { describe, expect, it } from "vitest";
import { formatCountdown, secondsUntil } from "./CreateInstallationWizard";

const NOW = Date.parse("2026-08-16T10:00:00Z");

describe("pairing code clock", () => {
  it("counts down to the code's own expiry", () => {
    expect(secondsUntil("2026-08-16T10:15:00Z", NOW)).toBe(900);
    expect(secondsUntil("2026-08-16T10:00:30Z", NOW)).toBe(30);
  });

  it("reads a past or unusable deadline as expired, never as time remaining", () => {
    expect(secondsUntil("2026-08-16T09:59:00Z", NOW)).toBe(0);
    expect(secondsUntil(undefined, NOW)).toBe(0);
    expect(secondsUntil("not a timestamp", NOW)).toBe(0);
  });

  it("formats as m:ss", () => {
    expect(formatCountdown(900)).toBe("15:00");
    expect(formatCountdown(61)).toBe("1:01");
    expect(formatCountdown(9)).toBe("0:09");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
