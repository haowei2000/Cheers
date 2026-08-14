export type WindowChromePaneGeometry = {
  railWidth: 56;
  sidebarWidth: 240;
  sidebarOpen: boolean;
};

export const DEFAULT_WINDOW_CHROME_PANES: Omit<
  WindowChromePaneGeometry,
  "sidebarOpen"
> = {
  railWidth: 56,
  sidebarWidth: 240,
};

export function createWindowChromePaneGeometry(
  sidebarOpen: boolean | undefined,
): WindowChromePaneGeometry | undefined {
  if (sidebarOpen === undefined) return undefined;
  return { ...DEFAULT_WINDOW_CHROME_PANES, sidebarOpen };
}

export function macosNativeControlsInset(
  fullscreen: boolean,
): 0 | 96 {
  return fullscreen ? 0 : 96;
}
