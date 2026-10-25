import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

function ok(bytes: number) {
  return Promise.resolve(new Response(new Blob([new Uint8Array(bytes)])));
}

describe("loadImageObjectUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    apiFetch.mockReset();
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++n}`);
    URL.revokeObjectURL = vi.fn();
  });

  it("downloads an image once and shares it between views", async () => {
    const { loadImageObjectUrl } = await import("./imageObjectUrl");
    apiFetch.mockImplementation(() => ok(10));
    const [a, b] = await Promise.all([loadImageObjectUrl("f1"), loadImageObjectUrl("f1")]);
    expect(a).toBe(b);
    expect(await loadImageObjectUrl("f1")).toBe(a);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith("/files/f1/preview");
  });

  it("retries after a failed load instead of caching the failure", async () => {
    const { loadImageObjectUrl } = await import("./imageObjectUrl");
    apiFetch.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 500 })));
    await expect(loadImageObjectUrl("f1")).rejects.toThrow();
    apiFetch.mockImplementationOnce(() => ok(10));
    await expect(loadImageObjectUrl("f1")).resolves.toMatch(/^blob:/);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used images past the byte budget", async () => {
    const { loadImageObjectUrl } = await import("./imageObjectUrl");
    const mb = 1024 * 1024;
    apiFetch.mockImplementation(() => ok(60 * mb));
    const first = await loadImageObjectUrl("a");
    await loadImageObjectUrl("b");
    await loadImageObjectUrl("a"); // touch: "b" is now the oldest
    await loadImageObjectUrl("c"); // 180 MB > 150 MB budget
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(first);
    await loadImageObjectUrl("b");
    expect(apiFetch).toHaveBeenCalledTimes(4);
  });
});
