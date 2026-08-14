import { createContext, useContext, type ReactNode } from "react";
import type { DesktopPlatform, WindowChromeVariant } from "./desktopPlatform";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  type DesktopWindowState,
} from "./WindowStateBridge";
import type { WindowChromePaneGeometry } from "./WindowChromeModel";

export type WindowChromePlacement = "inline" | "window";

type WindowChromeContextValue = {
  placement: WindowChromePlacement;
  actionsTarget: HTMLElement | null;
  platform: DesktopPlatform;
  variant: WindowChromeVariant;
  windowState: DesktopWindowState;
  panes?: WindowChromePaneGeometry;
};

const WindowChromeContext = createContext<WindowChromeContextValue>({
  placement: "inline",
  actionsTarget: null,
  platform: "web",
  variant: "inline",
  windowState: DEFAULT_DESKTOP_WINDOW_STATE,
});

export function WindowChromeProvider({
  placement,
  actionsTarget = null,
  platform = placement === "inline" ? "web" : "macos",
  variant = placement === "inline" ? "inline" : "macos-overlay",
  windowState = DEFAULT_DESKTOP_WINDOW_STATE,
  panes,
  children,
}: {
  placement: WindowChromePlacement;
  actionsTarget?: HTMLElement | null;
  platform?: DesktopPlatform;
  variant?: WindowChromeVariant;
  windowState?: DesktopWindowState;
  panes?: WindowChromePaneGeometry;
  children: ReactNode;
}) {
  return (
    <WindowChromeContext.Provider
      value={{ placement, actionsTarget, platform, variant, windowState, panes }}
    >
      {children}
    </WindowChromeContext.Provider>
  );
}

export function useWindowChromePlacement(): WindowChromePlacement {
  return useContext(WindowChromeContext).placement;
}

export function useWindowChromeActionsTarget(): HTMLElement | null {
  return useContext(WindowChromeContext).actionsTarget;
}

export function useWindowChromeContext(): WindowChromeContextValue {
  return useContext(WindowChromeContext);
}
