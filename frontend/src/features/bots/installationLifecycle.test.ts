import { describe, expect, it } from "vitest";
import {
  installationStatusLabel,
  mcpStateLabel,
  mcpStateTone,
  type InstallationLifecycleItem,
} from "./installationLifecycle";

function item(over: Partial<InstallationLifecycleItem> = {}): InstallationLifecycleItem {
  return {
    bot_id: "bot-1",
    installation_id: "inst-1",
    device_name: "Build Mac",
    status: "active",
    online: false,
    ...over,
  };
}

describe("installationStatusLabel", () => {
  it("separates the designated role from actual liveness", () => {
    // The trap the old raw-enum status had: "active" reads as "running" when it
    // only means "the one that may connect".
    expect(installationStatusLabel(item({ status: "active", online: false }))).toBe("Active, not connected");
    expect(installationStatusLabel(item({ status: "active", online: true }))).toBe("Online");
    expect(installationStatusLabel(item({ status: "standby" }))).toBe("Standby");
  });

  it("says what a pending row is waiting for", () => {
    expect(installationStatusLabel(item({ status: "pending" }))).toBe("Waiting for pairing");
  });

  it("reports revoked regardless of the underlying status", () => {
    for (const status of ["pending", "active", "standby"] as const) {
      expect(installationStatusLabel(item({ status, revoked_at: "2026-08-16T10:00:00Z" }))).toBe("Revoked");
    }
  });
});

describe("mcpStateLabel", () => {
  it("never shows a raw enum name", () => {
    const states = ["unconfigured", "action_required", "authorizing", "connected", "refresh_failed", "revoked"];
    for (const state of states) {
      expect(mcpStateLabel(state)).not.toMatch(/_/);
      expect(mcpStateLabel(state)).not.toBe(state);
    }
    expect(mcpStateLabel("something-new")).toBe("Not signed in yet");
  });

  it("colours only what the operator must act on", () => {
    expect(mcpStateTone("connected")).toBe("success");
    expect(mcpStateTone("action_required")).toBe("warning");
    expect(mcpStateTone("refresh_failed")).toBe("warning");
    expect(mcpStateTone("authorizing")).toBe("muted");
    expect(mcpStateTone("unconfigured")).toBe("muted");
  });
});
