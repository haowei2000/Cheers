import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type PresentationLevel = "max" | "medium" | "minimal";

const PresentationLevelContext = createContext<PresentationLevel>("medium");

const MEDIUM_QUERY = "(min-width: 768px)";
const MAX_QUERY = "(min-width: 1280px)";

function subscribeViewport(onChange: () => void): () => void {
  const medium = window.matchMedia(MEDIUM_QUERY);
  const max = window.matchMedia(MAX_QUERY);
  medium.addEventListener("change", onChange);
  max.addEventListener("change", onChange);
  return () => {
    medium.removeEventListener("change", onChange);
    max.removeEventListener("change", onChange);
  };
}

function viewportLevel(): PresentationLevel {
  if (window.matchMedia(MAX_QUERY).matches) return "max";
  if (window.matchMedia(MEDIUM_QUERY).matches) return "medium";
  return "minimal";
}

function serverLevel(): PresentationLevel {
  return "medium";
}

/** Responsive defaults: phone=minimal, regular window=medium, wide=max. */
export function useResponsivePresentationLevel(): PresentationLevel {
  return useSyncExternalStore(subscribeViewport, viewportLevel, serverLevel);
}

export function PresentationProvider({
  level,
  responsive = level === undefined,
  children,
}: {
  level?: PresentationLevel;
  responsive?: boolean;
  children: ReactNode;
}) {
  const responsiveLevel = useResponsivePresentationLevel();
  const value = useMemo(
    () => level ?? (responsive ? responsiveLevel : "medium"),
    [level, responsive, responsiveLevel]
  );
  return (
    <PresentationLevelContext.Provider value={value}>
      {children}
    </PresentationLevelContext.Provider>
  );
}

/** Explicit item level always wins over the nearest inherited container level. */
export function usePresentationLevel(
  explicit?: PresentationLevel
): PresentationLevel {
  const inherited = useContext(PresentationLevelContext);
  return explicit ?? inherited;
}
