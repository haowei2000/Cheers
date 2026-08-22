import { afterEach, describe, expect, it, vi } from "vitest";
import { createBot, createHost, listHostRepositories, redeemHostPairing } from "./bots";

function ok(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("bot and host API separation", () => {
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

  it("creates a pending host with its own agent", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => ok({
      bot_id: "bot-1",
      host_id: "host-1",
      pairing_code: "agbpair_secret",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createHost("bot-1", "codex", "Build Mac");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/bots\/bot-1\/hosts$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      agent_type: "codex",
      device_name: "Build Mac",
    });
  });

  it("redeems through the host pairing endpoint", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      ok({ host_id: "host-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await redeemHostPairing("agbpair_secret", "Build Mac");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/hosts\/redeem$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      pairing_code: "agbpair_secret",
      device_name: "Build Mac",
    });
  });

  it("discovers repositories through one concrete Bot Host", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      ok({ repositories: [{ path: "/repo", branch: "main" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listHostRepositories("bot-1", "host-1");

    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /\/bots\/bot-1\/hosts\/host-1\/repositories$/,
    );
    expect(result.repositories[0]).toEqual({ path: "/repo", branch: "main" });
  });
});
