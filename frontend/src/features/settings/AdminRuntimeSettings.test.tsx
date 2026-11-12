import { describe, expect, it } from "vitest";
import { describeValue, reviewDraft } from "./AdminRuntimeSettings";
import type { RuntimeSetting } from "@/api/adminSettings";

const setting: RuntimeSetting = {
  key: "approval_card_ttl_secs",
  label: "Approval card expiry",
  description: "Expiry",
  unit: "seconds",
  min: 1200,
  max: 86400,
  default_value: 1800,
  override_value: 3600,
  effective_value: 3600,
};

describe("reviewDraft", () => {
  it("treats the saved override as unchanged", () => {
    expect(reviewDraft("3600", setting)).toEqual({ next: 3600, changed: false, outOfRange: false });
  });

  it("reads a blank draft as returning to the default", () => {
    expect(reviewDraft("  ", setting)).toEqual({ next: null, changed: true, outOfRange: false });
    expect(reviewDraft("", { ...setting, override_value: null }).changed).toBe(false);
  });

  it("accepts the bounds and refuses anything outside them", () => {
    expect(reviewDraft("1200", setting).outOfRange).toBe(false);
    expect(reviewDraft("86400", setting).outOfRange).toBe(false);
    expect(reviewDraft("1199", setting).outOfRange).toBe(true);
    expect(reviewDraft("86401", setting).outOfRange).toBe(true);
    expect(reviewDraft("1500.5", setting).outOfRange).toBe(true);
  });
});

describe("describeValue", () => {
  it("names the default so history stays readable", () => {
    expect(describeValue(null, setting)).toBe("default (1800 seconds)");
    expect(describeValue(2400, setting)).toBe("2400 seconds");
  });
});
