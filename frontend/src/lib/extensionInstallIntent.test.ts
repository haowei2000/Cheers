import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearExtensionInstallIntent,
  parseExtensionInstallDeepLink,
  peekExtensionInstallIntent,
  storeExtensionInstallIntent,
} from "./extensionInstallIntent";

const hash = "a".repeat(64);
const source = `https://haowei2000.github.io/Cheers/downloads/extensions/notes-workflow/1.0.0/${hash}.cheers-extension`;
const link = `cheers://extension/install?${new URLSearchParams({ source, sha256: hash, id: "notes-workflow", version: "1.0.0" })}`;

describe("extension install deep links", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal("window", new EventTarget());
    clearExtensionInstallIntent();
  });

  it("accepts only canonical pinned official packages", () => {
    expect(parseExtensionInstallDeepLink(link)).toEqual({ source, sha256: hash, id: "notes-workflow", version: "1.0.0" });
    expect(parseExtensionInstallDeepLink(link.replace("https%3A%2F%2Fhaowei2000.github.io", "https%3A%2F%2Fexample.com"))).toBeNull();
    expect(parseExtensionInstallDeepLink(link.replace(hash, "BAD"))).toBeNull();
    expect(parseExtensionInstallDeepLink(link.replace("1.0.0", "latest"))).toBeNull();
    expect(parseExtensionInstallDeepLink("cheers://channel/123")).toBeNull();
  });

  it("persists a cold-start intent until the Workbench consumes it", () => {
    const intent = parseExtensionInstallDeepLink(link)!;
    const listener = vi.fn();
    window.addEventListener("cheers:extension-install-intent", listener);
    storeExtensionInstallIntent(intent);
    expect(peekExtensionInstallIntent()).toEqual(intent);
    expect(listener).toHaveBeenCalledOnce();
    clearExtensionInstallIntent();
    expect(peekExtensionInstallIntent()).toBeNull();
    window.removeEventListener("cheers:extension-install-intent", listener);
  });
});
