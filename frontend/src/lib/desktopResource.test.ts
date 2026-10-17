import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDesktopFile } from "./desktopResource";
import { invokeDesktop } from "./desktop";
import { isTauri } from "./serverConfig";

vi.mock("./desktop", () => ({ invokeDesktop: vi.fn() }));
vi.mock("./serverConfig", () => ({ isTauri: vi.fn(), getServerBase: () => "https://test.invalid" }));
describe("authorized desktop handoff", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
  it("opens an original only after the server-bound local-root probe succeeds", async () => {
    vi.mocked(invokeDesktop).mockResolvedValueOnce([{ key: "zed" }]).mockResolvedValueOnce(true).mockResolvedValueOnce(undefined);
    const getBytesB64 = vi.fn(() => "YQ==");
    expect(await openDesktopFile({ absPath: "/registered/a.txt", filename: "a.txt", getBytesB64, opener: "zed" })).toBe("local");
    expect(invokeDesktop).toHaveBeenNthCalledWith(2, "local_root_available", { root: "/registered/a.txt", server: "https://test.invalid" });
    expect(invokeDesktop).toHaveBeenLastCalledWith("open_local_path", { path: "/registered/a.txt", opener: "zed" });
    expect(getBytesB64).not.toHaveBeenCalled();
  });
  it("falls back to a labelled copy when the authorized workspace is remote", async () => {
    vi.mocked(invokeDesktop).mockResolvedValueOnce([{ key: "finder" }]).mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
    expect(await openDesktopFile({ absPath: "/remote/empty.txt", filename: "empty.txt", getBytesB64: () => "", opener: "finder" })).toBe("downloaded-copy");
    expect(invokeDesktop).toHaveBeenLastCalledWith("open_remote_file", { filename: "empty.txt", contentB64: "", opener: "finder" });
  });
  it("refuses unsupported clients and applications before opening anything", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(openDesktopFile({ filename: "a", getBytesB64: () => "YQ==", opener: "zed" })).rejects.toThrow("Cheers for Mac");
    expect(invokeDesktop).not.toHaveBeenCalled();
    vi.mocked(isTauri).mockReturnValue(true);
    vi.mocked(invokeDesktop).mockResolvedValueOnce([{ key: "finder" }]);
    await expect(openDesktopFile({ filename: "a", getBytesB64: () => "YQ==", opener: "zed" })).rejects.toThrow("unavailable");
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
  });
});
