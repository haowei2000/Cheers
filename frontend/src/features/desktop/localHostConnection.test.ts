import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareLocalHost, startLocalHost } from "./localHostConnection";
import { invokeDesktop } from "@/lib/desktop";
import { createHost, listConnectorHosts, redeemHostPairing, revokeConnectorHost } from "@/api/bots";

vi.mock("@/lib/desktop", () => ({ invokeDesktop: vi.fn() }));
vi.mock("@/api/bots", () => ({ createHost: vi.fn(), listConnectorHosts: vi.fn(), redeemHostPairing: vi.fn(), revokeConnectorHost: vi.fn() }));

describe("local host connection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createHost).mockResolvedValue({ host_id: "new-host", pairing_code: "single-use" } as never);
    vi.mocked(redeemHostPairing).mockResolvedValue({ account_id: "helper", config_toml: "config", credential: "secret", credential_file: "secrets/host" } as never);
    vi.mocked(invokeDesktop).mockImplementation(async (command) => {
      if (command === "detect_agents") return [{ key: "codex", label: "Codex", installed: true, installable: true }] as never;
      if (command === "connector_write_onboarded") return "/config.toml" as never;
      if (command === "connector_list") return [] as never;
      return undefined as never;
    });
  });

  it("does not allocate a host when agent detection fails", async () => {
    vi.mocked(invokeDesktop).mockRejectedValueOnce(new Error("offline registry"));
    await expect(prepareLocalHost("bot", "codex", "/project")).rejects.toThrow("offline registry");
    expect(createHost).not.toHaveBeenCalled();
  });

  it("saves the selected project with credentials before starting", async () => {
    const host = await prepareLocalHost("bot", "codex", "/project");
    expect(invokeDesktop).toHaveBeenCalledWith("connector_write_onboarded", expect.objectContaining({ workspacePath: "/project", instanceName: "helper-new-host" }));
    expect(invokeDesktop).not.toHaveBeenCalledWith("connector_start", expect.anything());
    vi.mocked(listConnectorHosts).mockResolvedValue([{ host_id: "new-host", online: true, status: "active" }] as never);
    await startLocalHost(host);
    expect(createHost).toHaveBeenCalledTimes(1);
  });

  it("revokes an allocated host if saving its configuration fails", async () => {
    vi.mocked(invokeDesktop).mockImplementation(async (command) => {
      if (command === "detect_agents") return [{ key: "codex", installed: true }] as never;
      throw new Error("folder no longer exists");
    });
    await expect(prepareLocalHost("bot", "codex", "/project")).rejects.toThrow("folder no longer exists");
    expect(revokeConnectorHost).toHaveBeenCalledWith("bot", "new-host");
  });

  it("reuses a running saved host on retry and reports standby", async () => {
    vi.mocked(invokeDesktop).mockResolvedValueOnce([{ name: "helper-new-host", running: true }] as never);
    vi.mocked(listConnectorHosts).mockResolvedValue([{ host_id: "new-host", online: true, status: "standby" }] as never);
    await expect(startLocalHost({ botId: "bot", hostId: "new-host", name: "helper-new-host", configPath: "/config.toml" })).resolves.toBe("standby");
    expect(invokeDesktop).not.toHaveBeenCalledWith("connector_start", expect.anything());
    expect(createHost).not.toHaveBeenCalled();
  });

  it("checks the new host rather than an already online host for the same bot", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(listConnectorHosts)
        .mockResolvedValueOnce([{ host_id: "other-host", online: true }] as never)
        .mockResolvedValueOnce([{ host_id: "new-host", online: true, status: "active" }] as never);
      const started = startLocalHost({ botId: "bot", hostId: "new-host", name: "helper", configPath: "/config.toml" });
      await vi.runAllTimersAsync();
      await started;
      expect(listConnectorHosts).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
