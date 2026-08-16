import { describe, expect, it } from "vitest";
import { botUsernameError } from "./botUsername";

describe("botUsernameError", () => {
  it("accepts names that survive @mention and connector account-id round-trips", () => {
    for (const name of ["research-assistant", "Bot_2", "a", "x".repeat(64), "  helper  "]) {
      expect(botUsernameError(name)).toBeNull();
    }
  });

  it("names a fixable problem instead of leaving it to the database", () => {
    // VARCHAR(64) — one over used to surface as a 500 "internal error".
    expect(botUsernameError("x".repeat(65))).toMatch(/64 characters or fewer/);
    // These would store a name that no longer matches its own mention token or
    // the sanitized connector account id.
    for (const name of ["my bot", "@helper", "-leading", "béta", "bot!"]) {
      expect(botUsernameError(name)).toMatch(/letters, digits/);
    }
    expect(botUsernameError("   ")).toBe("Username is required.");
  });
});
