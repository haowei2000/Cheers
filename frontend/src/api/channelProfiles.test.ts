import { afterEach, describe, expect, it, vi } from "vitest";
import { putCodeProfile } from "./channelProfiles";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Code profile API", () => {
  it("keeps the optional remote source separate from the execution target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: "code",
      config: {},
      status: { state: "pending" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await putCodeProfile("channel-1", {
      remote_source: {
        kind: "github",
        installation_id: "installation-1",
        repository: "owner/repo",
        branch: "main",
      },
      execution_target: { bot_id: "bot-1", host_id: "host-1" },
    });

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      remote_source: {
        kind: "github",
        installation_id: "installation-1",
        repository: "owner/repo",
        branch: "main",
      },
      execution_target: { bot_id: "bot-1", host_id: "host-1" },
    });
  });

  it("allows a local-only profile without GitHub configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: "code",
      config: {},
      status: { state: "unconfigured" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await putCodeProfile("channel-1", {});

    const [, init] = fetchMock.mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({});
  });
});
