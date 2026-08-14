import { afterEach, describe, expect, it, vi } from "vitest";
import { createBot, createInstallation, redeemInstallationPairing } from "./bots";

function ok(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("bot and installation API separation", () => {
  it("creates only a bot identity", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      ok({ bot_id: "bot-1", username: "helper" }));
    vi.stubGlobal("fetch", fetchMock);

    await createBot({ username: "helper", display_name: "Helper" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/bots$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      username: "helper",
      display_name: "Helper",
    });
  });

  it("creates a pending installation with its own agent", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => ok({
      bot_id: "bot-1",
      installation_id: "installation-1",
      pairing_code: "agbpair_secret",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createInstallation("bot-1", "codex", "Build Mac");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/bots\/bot-1\/installations$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      agent_type: "codex",
      device_name: "Build Mac",
    });
  });

  it("redeems through the installation pairing endpoint", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      ok({ installation_id: "installation-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await redeemInstallationPairing("agbpair_secret", "Build Mac");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/installations\/redeem$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      pairing_code: "agbpair_secret",
      device_name: "Build Mac",
    });
  });
});
