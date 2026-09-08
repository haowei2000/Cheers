import { createContext, useContext, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

export interface ManagedPanel {
  floating: boolean;
  canFloat: boolean;
  toFront: () => void;
  visible: boolean;
  style: CSSProperties;
  toggleFloating: () => void;
  dragProps: {
    onPointerDown: (event: ReactPointerEvent) => void;
    style: CSSProperties;
  };
  resizeProps: {
    onPointerDown: (event: ReactPointerEvent) => void;
    style: CSSProperties;
  };
}

export type ManagedPanelResolver = (kind: string) => ManagedPanel;

const ManagedPanelContext = createContext<ManagedPanelResolver | null>(null);

export function ManagedPanelProvider({
  resolve,
  children,
}: {
  resolve: ManagedPanelResolver;
  children: ReactNode;
}) {
  return (
    <ManagedPanelContext.Provider value={resolve}>
      {children}
    </ManagedPanelContext.Provider>
  );
}

export function useManagedPanel(kind?: string, viewport?: boolean) {
  const resolve = useContext(ManagedPanelContext);
  return kind && !viewport && resolve ? resolve(kind) : null;
}
