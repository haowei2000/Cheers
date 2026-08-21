import { describe, expect, it, vi } from "vitest";
import {
  acceptOAuthDeepLink,
  onOAuthHandoff,
  onOAuthLinked,
} from "./oauthCallback";

describe("OAuth deep links", () => {
  it("delivers a completed account link to an active listener", () => {
    const listener = vi.fn();
    const unsubscribe = onOAuthLinked(listener);

    expect(acceptOAuthDeepLink("cheers://auth/callback?linked=github")).toBe(true);
    expect(listener).toHaveBeenCalledWith("github");

    unsubscribe();
  });

  it("buffers a completed account link until the settings page mounts", async () => {
    expect(acceptOAuthDeepLink("cheers://auth/callback?linked=google")).toBe(true);
    const listener = vi.fn();
    const unsubscribe = onOAuthLinked(listener);

    await Promise.resolve();
    expect(listener).toHaveBeenCalledWith("google");

    unsubscribe();
  });

  it("continues to deliver login handoff codes", () => {
    const listener = vi.fn();
    const unsubscribe = onOAuthHandoff(listener);

    expect(acceptOAuthDeepLink("cheers://auth/callback?code=handoff-code")).toBe(true);
    expect(listener).toHaveBeenCalledWith("handoff-code");

    unsubscribe();
  });
});
