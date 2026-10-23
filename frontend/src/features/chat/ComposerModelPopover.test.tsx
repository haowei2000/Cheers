import { describe, expect, it } from "vitest";
import { effectiveModelLabel } from "./ComposerModelPopover";
import type { BotControlsEntry } from "./sessionControlsCache";

const data: BotControlsEntry = {
  controls: {
    can_set_mode: true, can_set_config_option: true, can_create_session: true,
    can_close_session: true, can_set_primary: true, allowed_modes: [],
    config_options: [{ id: "model", name: "Model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default model" }, { value: "fast", name: "Fast model" }] }],
  },
  sessions: [{ session_id: "pinned", role: "other", is_primary: true, status: "idle", last_used_at: "", session_config: { config_options: { model: "fast" } } }],
};

describe("effective model label", () => {
  it("shows the session override's human label and the advertised default when no session exists", () => {
    expect(effectiveModelLabel(data, "pinned")).toBe("Fast model");
    expect(effectiveModelLabel({ ...data, sessions: [] }, "")).toBe("Default model");
  });
  it("does not show another session's model for a missing pinned target", () => {
    expect(effectiveModelLabel(data, "missing")).toBeNull();
    expect(effectiveModelLabel(undefined, "")).toBeNull();
  });
});
