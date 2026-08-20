import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiJson, errorMessage } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
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
});
