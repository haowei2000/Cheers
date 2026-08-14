import type { ReactNode } from "react";
import { WindowChromeActions } from "./WindowChromeActions";
import { useWindowChromePlacement } from "./WindowChromeContext";

/**
 * Lets a route keep ownership of its header without rendering that header
 * twice in a desktop window shell. Web keeps the route's inline header; the
 * desktop frame contributes the title and receives only contextual actions
 * through its typed window chrome slot.
 */
export function RouteChromeHeader({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  const placement = useWindowChromePlacement();

  if (placement === "window") {
    return actions ? <WindowChromeActions>{actions}</WindowChromeActions> : null;
  }

  return <>{children}</>;
}
