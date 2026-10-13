import { beforeEach, describe, expect, it, vi } from "vitest";
import { passkeyFactorVerify, verifyLoginFlowCode, verifyLoginFlowPasskey, verifyLoginFlowPassword } from "./auth";
import { apiJson } from "./client";
import { invokeDesktop } from "@/lib/desktop";
import { isTauri } from "@/lib/serverConfig";

vi.mock("./client", () => ({ apiJson: vi.fn(), currentAccessToken: vi.fn() }));
vi.mock("@/lib/desktop", () => ({ invokeDesktop: vi.fn() }));
vi.mock("@/lib/serverConfig", () => ({ isTauri: vi.fn(), getServerBase: () => "https://cheers.example" }));

describe("device trust at the authentication boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sends the explicit web trust preference for every unified login method", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await verifyLoginFlowPassword("flow", "password", false);
    await verifyLoginFlowCode("flow", "email", "123456", false);
    await verifyLoginFlowPasskey("flow", { id: "credential" }, false);
    for (const [, request] of vi.mocked(apiJson).mock.calls) {
      expect(JSON.parse(request!.body as string).remember_device).toBe(false);
    }
  });

  it("routes OAuth passkey completion through native Keychain persistence", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    await passkeyFactorVerify({ transaction_id: "oauth-factor", credential: { id: "credential" }, remember_device: true });
    expect(invokeDesktop).toHaveBeenCalledWith("desktop_verify_passkey_factor", {
      serverBase: "https://cheers.example", transactionId: "oauth-factor", credential: { id: "credential" }, rememberDevice: true,
    });
    expect(apiJson).not.toHaveBeenCalled();
  });
});
