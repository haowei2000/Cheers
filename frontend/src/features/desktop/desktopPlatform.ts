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

/** Lowercased platform + user agent, the haystack both resolvers search. */
function platformText(
  environment: Pick<Partial<PlatformEnvironment>, "platform" | "userAgent">,
): string {
  return `${environment.platform ?? browserPlatform()} ${
    environment.userAgent ?? (typeof navigator === "undefined" ? "" : navigator.userAgent)
  }`.toLocaleLowerCase();
}

export function usesMacKeyboardShortcuts(
  environment: Pick<Partial<PlatformEnvironment>, "platform" | "userAgent"> = {},
): boolean {
  return platformText(environment).includes("mac");
}

/** Resolve the desktop shell once without making route components platform-aware. */
export function resolveDesktopPlatform(
  environment: Partial<PlatformEnvironment> = {},
): DesktopPlatform {
  const tauri = environment.tauri ?? isTauri();
  if (!tauri) return "web";

  const value = platformText(environment);

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
