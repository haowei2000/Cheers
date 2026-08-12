import { createContext, useContext, type ReactNode } from "react";

/**
 * Visual control density is independent from PresentationLevel. Presentation
 * controls information anatomy; ControlSize controls the shared physical rhythm.
 */
export type ControlSize = "compact" | "regular" | "comfortable";

const ControlSizeContext = createContext<ControlSize>("regular");

export function ControlSizeProvider({
  size,
  children,
}: {
  size: ControlSize;
  children: ReactNode;
}) {
  return (
    <ControlSizeContext.Provider value={size}>
      {children}
    </ControlSizeContext.Provider>
  );
}

export function useControlSize(explicit?: ControlSize): ControlSize {
  return explicit ?? useContext(ControlSizeContext);
}

export const controlHeightClasses: Record<ControlSize, string> = {
  compact: "h-7 max-md:h-11",
  regular: "h-9 max-md:h-11",
  comfortable: "h-11",
};

export const controlMinHeightClasses: Record<ControlSize, string> = {
  compact: "min-h-7 max-md:min-h-11",
  regular: "min-h-9 max-md:min-h-11",
  comfortable: "min-h-11",
};

export const controlSquareClasses: Record<ControlSize, string> = {
  compact: "h-7 w-7 max-md:h-11 max-md:w-11",
  regular: "h-9 w-9 max-md:h-11 max-md:w-11",
  comfortable: "h-11 w-11",
};

export const controlTextClasses: Record<ControlSize, string> = {
  compact: "text-compact",
  regular: "text-regular",
  comfortable: "text-comfortable",
};

/** Supporting copy uses the next quieter registered tier, never an ad-hoc size. */
export const controlSupportingTextClasses: Record<ControlSize, string> = {
  compact: "text-compact",
  regular: "text-compact",
  comfortable: "text-regular",
};

export const controlIconClasses: Record<ControlSize, string> = {
  compact: "h-3.5 w-3.5",
  regular: "h-4 w-4",
  comfortable: "h-5 w-5",
};
