import { afterEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/authStore";
import { completeStepUp, hasPendingStepUp } from "@/lib/stepUpCoordinator";
import { ApiError, apiJson, errorMessage } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ token: null });
});

describe("errorMessage", () => {
  it("preserves Error messages", () => {
    expect(errorMessage(new Error("Server rejected the handoff"), "fallback"))
      .toBe("Server rejected the handoff");
  });

  it("preserves plain-string Tauri command errors", () => {
    expect(errorMessage("Could not reach the Cheers server", "fallback"))
      .toBe("Could not reach the Cheers server");
  });

  it("uses the fallback for unsafe or empty values", () => {
    expect(errorMessage({ detail: "secret" }, "OAuth login failed"))
      .toBe("OAuth login failed");
    expect(errorMessage("   ", "OAuth login failed")).toBe("OAuth login failed");
  });
});

describe("apiJson", () => {
  it("preserves structured recovery metadata from API errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "account_link_required",
      provider: "github",
      message: "Sign in with an existing method, then link GitHub.",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    const error = await apiJson("/auth/oauth/handoff").catch((reason) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "account_link_required",
      provider: "github",
      message: "Sign in with an existing method, then link GitHub.",
    });
  });

  it("coordinates and retries only an opted-in structured recent-auth 428", async () => {
    useAuthStore.setState({ token: "active-token" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "ai_consent_required",
        disclosures: [],
      }), { status: 428, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "recent_authentication_required",
        detail: "Sign in again before changing security-sensitive access.",
      }), { status: 428, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await apiJson("/messages").catch(() => undefined);
    expect(hasPendingStepUp()).toBe(false);

    const request = apiJson<{ ok: boolean }>(
      "/bots/bot-1/token",
      { method: "POST" },
      { recentAuth: "auto" }
    );
    await vi.waitFor(() => expect(hasPendingStepUp()).toBe(true));
    completeStepUp();
    await expect(request).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not loop when the one retry also requires recent authentication", async () => {
    useAuthStore.setState({ token: "active-token" });
    const response = () => new Response(JSON.stringify({
      code: "recent_authentication_required",
      detail: "Confirm your identity.",
    }), { status: 428, headers: { "Content-Type": "application/json" } });
    const fetchMock = vi.fn().mockImplementation(response);
    vi.stubGlobal("fetch", fetchMock);

    const request = apiJson(
      "/bots/bot-1/token",
      { method: "POST" },
      { recentAuth: "auto", actionClass: "bot_token_issue" }
    );
    await vi.waitFor(() => expect(hasPendingStepUp()).toBe(true));
    completeStepUp();
    await expect(request).rejects.toMatchObject({
      status: 428,
      code: "recent_authentication_required",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasPendingStepUp()).toBe(false);
  });
});
