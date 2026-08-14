import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWindowChromeActionsTarget } from "./WindowChromeContext";

/**
 * Keeps contextual controls owned by their route while presenting them in the
 * platform renderer selected by the window chrome host.
 */
export function WindowChromeActions({ children }: { children: ReactNode }) {
  const target = useWindowChromeActionsTarget();

  if (!target) return null;
  return createPortal(children, target);
}
