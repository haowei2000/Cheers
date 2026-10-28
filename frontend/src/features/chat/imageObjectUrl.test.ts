import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const mb = 1024 * 1024;

function ok(bytes: number) {
  return Promise.resolve(new Response(new Blob([new Uint8Array(bytes)])));
}

/** A download that lands only when `land` is called. */
function deferred(bytes: number) {
  let land = () => {};
  const response = new Promise<Response>((resolve) => {
    land = () => resolve(new Response(new Blob([new Uint8Array(bytes)])));
  });
  return { response, land: () => land() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("acquireImageObjectUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetch.mockReset();
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++n}`);
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("downloads an image once and shares it between views", async () => {
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    apiFetch.mockImplementation(() => ok(10));
    const a = acquireImageObjectUrl("f1");
    const b = acquireImageObjectUrl("f1");
    expect(await a.url).toBe(await b.url);
    a.release();
    b.release();
    expect(await acquireImageObjectUrl("f1").url).toBe(await a.url);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/files/f1/preview");
  });

  it("retries after a failed load instead of caching the failure", async () => {
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    apiFetch.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 500 })));
    await expect(acquireImageObjectUrl("f1").url).rejects.toThrow();
    apiFetch.mockImplementationOnce(() => ok(10));
    await expect(acquireImageObjectUrl("f1").url).resolves.toMatch(/^blob:/);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used released images past the byte budget", async () => {
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    apiFetch.mockImplementation(() => ok(60 * mb));
    const load = async (id: string) => {
      const lease = acquireImageObjectUrl(id);
      const url = await lease.url;
      lease.release();
      return url;
    };
    const a = await load("a");
    const b = await load("b");
    await load("a"); // touch: "b" is now the oldest
    await load("c"); // 180 MB > 150 MB budget
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(b);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(a);
    await load("b");
    expect(apiFetch).toHaveBeenCalledTimes(4);
  });

  it("never revokes an image a view still holds or one still downloading", async () => {
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    const slow = deferred(10 * mb);
    apiFetch.mockImplementation((path: string) =>
      path === "/files/pending/preview" ? slow.response : ok(100 * mb),
    );
    const held = acquireImageObjectUrl("held");
    const heldUrl = await held.url;
    const pending = acquireImageObjectUrl("pending"); // in flight, oldest unheld
    const big = acquireImageObjectUrl("big");
    const bigUrl = await big.url; // 200 MB > budget, but nothing is evictable
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    slow.land();
    const pendingUrl = await pending.url;
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(pendingUrl);

    big.release(); // now evictable
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(bigUrl);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(heldUrl);
    held.release();
    pending.release();
  });

  it("drops every image when the signed-in account changes", async () => {
    // The browser's session-cleared event; tests run without a DOM.
    vi.stubGlobal("window", new EventTarget());
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    const { clearClientSessionData } = await import("@/lib/clientSession");
    const slow = deferred(10);
    let lateCalls = 0;
    apiFetch.mockImplementation((path: string) =>
      path === "/files/late/preview" && lateCalls++ === 0 ? slow.response : ok(10),
    );
    const cached = acquireImageObjectUrl("f1");
    const cachedUrl = await cached.url;
    cached.release();
    const late = acquireImageObjectUrl("late");

    clearClientSessionData();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(cachedUrl);
    slow.land();
    await expect(late.url).rejects.toThrow();
    await flush();

    await acquireImageObjectUrl("f1").url;
    await acquireImageObjectUrl("late").url;
    expect(apiFetch).toHaveBeenCalledTimes(4);
  });

  it("never serves a previous account's image even without the clear event", async () => {
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    const { clearClientSessionData } = await import("@/lib/clientSession");
    apiFetch.mockImplementation(() => ok(10));
    const before = acquireImageObjectUrl("f1");
    const beforeUrl = await before.url;
    before.release();

    clearClientSessionData();
    const after = acquireImageObjectUrl("f1");
    expect(await after.url).not.toBe(beforeUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(beforeUrl);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches an unheld image after the reuse window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { acquireImageObjectUrl } = await import("./imageObjectUrl");
    apiFetch.mockImplementation(() => ok(10));
    const first = acquireImageObjectUrl("f1");
    const firstUrl = await first.url;

    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    const again = acquireImageObjectUrl("f1");
    expect(await again.url).toBe(firstUrl);
    again.release();
    first.release();
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await acquireImageObjectUrl("f1").url;
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(firstUrl);
  });
});
