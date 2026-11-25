import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { ControlSizeProvider } from "@/components/ui/control-size";
import { useWindowChromeActionsTarget } from "./WindowChromeContext";

/**
 * Keeps contextual controls owned by their route while presenting them in the
 * platform renderer selected by the window chrome host.
 */
export function WindowChromeActions({ children }: { children: ReactNode }) {
  const target = useWindowChromeActionsTarget();

  if (!target) return null;
  // Route actions inherit the titlebar's navigation size, so every button in the
  // bar shares one height and one hover/selected surface.
  return createPortal(<ControlSizeProvider size="regular">{children}</ControlSizeProvider>, target);
}
