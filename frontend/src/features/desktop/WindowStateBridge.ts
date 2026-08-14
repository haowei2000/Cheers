import { useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { DesktopPlatform } from "./desktopPlatform";

export type DesktopWindowState = {
  active: boolean;
  fullscreen: boolean;
  maximized: boolean;
  scaleFactor: number;
};

export const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = {
  active: true,
  fullscreen: false,
  maximized: false,
  scaleFactor: 1,
};

/**
 * Bridges native window state into React. Geometry decisions live in the
 * window chrome host, while routes only contribute semantic content/actions.
 */
export function useDesktopWindowState(
  platform: DesktopPlatform,
): DesktopWindowState {
  const [state, setState] = useState(DEFAULT_DESKTOP_WINDOW_STATE);

  useEffect(() => {
    if (platform === "web") {
      setState(DEFAULT_DESKTOP_WINDOW_STATE);
      return;
    }

    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const remember = (unlisten: UnlistenFn) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const window = getCurrentWindow();
        const syncWindowMode = async () => {
          const [active, fullscreen, maximized, scaleFactor] = await Promise.all([
            window.isFocused(),
            window.isFullscreen(),
            window.isMaximized(),
            window.scaleFactor(),
          ]);
          if (!disposed) setState({ active, fullscreen, maximized, scaleFactor });
        };

        await syncWindowMode();
        remember(
          await window.onFocusChanged(({ payload: active }) => {
            setState((current) => ({ ...current, active }));
          }),
        );
        remember(await window.onResized(() => void syncWindowMode()));
        remember(
          await window.onScaleChanged(({ payload }) => {
            setState((current) => ({ ...current, scaleFactor: payload.scaleFactor }));
          }),
        );
      } catch {
        // The frame still renders with safe defaults if a capability is absent.
      }
    })();

    return () => {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
    };
  }, [platform]);

  return state;
}
