import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./authStore";
import { apiBase, getServerBase, isTauri } from "@/lib/serverConfig";
import { invokeDesktop } from "@/lib/desktop";
import { clientSessionGeneration } from "@/lib/clientSession";
import { queryClient } from "@/lib/queryClient";

vi.mock("@/lib/serverConfig", () => ({
  apiBase: vi.fn(), getServerBase: vi.fn(), isTauri: vi.fn(),
}));
vi.mock("@/lib/desktop", () => ({ invokeDesktop: vi.fn() }));

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

const originalUser = { user_id: "user-1", display_name: "Original" };
const nextUser = { user_id: "user-2", display_name: "Next account" };

function delayedRefresh(desktop: boolean) {
  vi.mocked(isTauri).mockReturnValue(desktop);
  vi.mocked(getServerBase).mockReturnValue(desktop ? "https://old.example" : null);
  const pending = deferred<typeof refreshedSession>();
  if (desktop) {
    vi.mocked(invokeDesktop).mockReturnValue(pending.promise);
  } else {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(await pending.promise), {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
  }
  return pending;
}

describe("restoreSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiBase).mockReturnValue("/api/v1");
    vi.mocked(getServerBase).mockReturnValue(null);
    vi.mocked(isTauri).mockReturnValue(false);
    useAuthStore.getState().logout();
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
    expect(await Promise.all([first, second])).toEqual([
      "fresh-access-token", "fresh-access-token",
    ]);

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

  describe.each([false, true])("stale refresh (desktop=%s)", (desktop) => {
    it.each([false, true])("does not resurrect logout (previously signed in=%s)", async (signedIn) => {
      if (signedIn) useAuthStore.getState().setAuth(originalUser, "old-token");
      const pending = delayedRefresh(desktop);
      const restore = useAuthStore.getState().restoreSession();
      useAuthStore.getState().logout();
      pending.resolve(refreshedSession);

      expect(await restore).toBeNull();
      expect(useAuthStore.getState()).toMatchObject({ user: null, token: null, initialized: true });
    });

    it("returns null without replacing a new login", async () => {
      useAuthStore.getState().setAuth(originalUser, "old-token");
      const pending = delayedRefresh(desktop);
      const restore = useAuthStore.getState().restoreSession();
      useAuthStore.getState().setAuth(nextUser, "new-login-token");
      pending.resolve(refreshedSession);

      expect(await restore).toBeNull();
      expect(useAuthStore.getState()).toMatchObject({ user: nextUser, token: "new-login-token" });
    });

    it("returns null without replacing an explicitly updated token", async () => {
      useAuthStore.getState().setAuth(originalUser, "old-token");
      const pending = delayedRefresh(desktop);
      const restore = useAuthStore.getState().restoreSession();
      useAuthStore.getState().setToken("password-rotated-token");
      pending.resolve(refreshedSession);

      expect(await restore).toBeNull();
      expect(useAuthStore.getState()).toMatchObject({ user: originalUser, token: "password-rotated-token" });
    });

    it("rejects a refresh from before logout even if the next login reuses the identity strings", async () => {
      useAuthStore.getState().setAuth(originalUser, "old-token");
      const pending = delayedRefresh(desktop);
      const restore = useAuthStore.getState().restoreSession();
      useAuthStore.getState().logout();
      useAuthStore.getState().setAuth(originalUser, "old-token");
      pending.resolve(refreshedSession);

      expect(await restore).toBeNull();
      expect(useAuthStore.getState()).toMatchObject({ user: originalUser, token: "old-token" });
    });

    it("refreshes credentials without overwriting a concurrent same-account profile edit", async () => {
      useAuthStore.getState().setAuth(originalUser, "old-token");
      const pending = delayedRefresh(desktop);
      const restore = useAuthStore.getState().restoreSession();
      const updatedUser = { ...originalUser, display_name: "Edited profile" };
      useAuthStore.getState().setAuth(updatedUser, "old-token");
      pending.resolve(refreshedSession);

      expect(await restore).toBe("fresh-access-token");
      expect(useAuthStore.getState()).toMatchObject({
        user: { ...updatedUser, role: "admin" }, token: "fresh-access-token",
      });
    });
  });

  it("keeps a newer session's refresh singleflight after an older request finishes", async () => {
    useAuthStore.getState().setAuth(originalUser, "old-token");
    const oldRequest = deferred<Response>();
    const newRequest = deferred<Response>();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(newRequest.promise);
    vi.stubGlobal("fetch", fetchMock);

    const oldRestore = useAuthStore.getState().restoreSession();
    useAuthStore.getState().setToken("updated-token");
    const newRestore = useAuthStore.getState().restoreSession();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    oldRequest.resolve(okRefreshResponse());
    expect(await oldRestore).toBeNull();
    const sameNewRestore = useAuthStore.getState().restoreSession();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    newRequest.resolve(okRefreshResponse());
    expect(await Promise.all([newRestore, sameNewRestore])).toEqual([
      "fresh-access-token", "fresh-access-token",
    ]);
  });

  it("rejects a desktop result after the selected server changes", async () => {
    useAuthStore.getState().setAuth(originalUser, "old-token");
    const pending = delayedRefresh(true);
    const restore = useAuthStore.getState().restoreSession();
    vi.mocked(getServerBase).mockReturnValue("https://new.example");
    pending.resolve(refreshedSession);

    expect(await restore).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ user: originalUser, token: "old-token" });
  });

  it("clears client data on account changes while preserving same-account profile edits", () => {
    useAuthStore.getState().setAuth(originalUser, "old-token");
    queryClient.setQueryData(["private-user-data"], "cached account data");
    const generation = clientSessionGeneration();
    useAuthStore.getState().setAuth({ ...originalUser, display_name: "Edited" }, "old-token");
    expect(clientSessionGeneration()).toBe(generation);
    expect(queryClient.getQueryData(["private-user-data"])).toBe("cached account data");

    useAuthStore.getState().setAuth(nextUser, "new-token");
    expect(clientSessionGeneration()).toBeGreaterThan(generation);
    expect(queryClient.getQueryData(["private-user-data"])).toBeUndefined();
  });

});
