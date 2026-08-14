import { isTauri } from "@/lib/serverConfig";

export type DesktopPlatform = "macos" | "windows" | "linux" | "web";
export type WindowChromeVariant = "macos-overlay" | "desktop-commandbar" | "inline";

type PlatformEnvironment = {
  tauri: boolean;
  platform: string;
  userAgent: string;
};

function browserPlatform(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || navigator.platform || "";
}

export function usesMacKeyboardShortcuts(
  environment: Pick<Partial<PlatformEnvironment>, "platform" | "userAgent"> = {},
): boolean {
  const value = `${environment.platform ?? browserPlatform()} ${
    environment.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent)
  }`.toLocaleLowerCase();
  return value.includes("mac");
}

/** Resolve the desktop shell once without making route components platform-aware. */
export function resolveDesktopPlatform(
  environment: Partial<PlatformEnvironment> = {},
): DesktopPlatform {
  const tauri = environment.tauri ?? isTauri();
  if (!tauri) return "web";

  const value = `${environment.platform ?? browserPlatform()} ${
    environment.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent)
  }`.toLocaleLowerCase();

  if (value.includes("mac")) return "macos";
  if (value.includes("win")) return "windows";
  return "linux";
}

export function resolveWindowChromeVariant(
  platform: DesktopPlatform,
): WindowChromeVariant {
  if (platform === "macos") return "macos-overlay";
  if (platform === "windows" || platform === "linux") return "desktop-commandbar";
  return "inline";
}
