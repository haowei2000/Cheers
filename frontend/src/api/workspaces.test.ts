import { afterEach, describe, expect, it, vi } from "vitest";
import { addWorkspaceMember } from "./workspaces";

afterEach(() => vi.unstubAllGlobals());

describe("workspace member API", () => {
  it("uses the same polymorphic member contract for bots", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ status: "active" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await addWorkspaceMember("workspace-1", {
      member_id: "bot-1",
      member_type: "bot",
      role: "member",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/workspaces\/workspace-1\/members$/);
    expect(JSON.parse(init?.body as string)).toEqual({
      member_id: "bot-1",
      member_type: "bot",
      role: "member",
    });
  });
});
