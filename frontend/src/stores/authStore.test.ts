import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./authStore";

const refreshedSession = {
  access_token: "fresh-access-token",
  user_id: "user-1",
  username: "haowei",
  display_name: "Haowei",
  role: "admin",
};

function okRefreshResponse(): Response {
  return new Response(JSON.stringify(refreshedSession), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("restoreSession", () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      token: null,
      initialized: false,
      sessionExpired: false,
    });
    vi.stubGlobal("navigator", {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one refresh request between concurrent callers in the same tab", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = useAuthStore.getState().restoreSession();
    const second = useAuthStore.getState().restoreSession();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(okRefreshResponse());
    await Promise.all([first, second]);

    expect(useAuthStore.getState()).toMatchObject({
      token: "fresh-access-token",
      initialized: true,
      sessionExpired: false,
    });
  });

  it("uses a named Web Lock to serialize refreshes across tabs", async () => {
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal("navigator", { locks: { request } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okRefreshResponse()));

    await useAuthStore.getState().restoreSession();

    expect(request).toHaveBeenCalledWith("cheers-auth-refresh", expect.any(Function));
  });

  it("retries once when the server reports a concurrent cookie rotation", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(okRefreshResponse());
    vi.stubGlobal("fetch", fetchMock);

    const restore = useAuthStore.getState().restoreSession();
    await vi.runAllTimersAsync();
    await restore;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().token).toBe("fresh-access-token");
  });
});
