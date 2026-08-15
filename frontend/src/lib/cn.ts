import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Teach tailwind-merge that the four design-system typography utilities are
 * font sizes, not arbitrary `text-*` colors. Without this, `text-regular`
 * could erase `text-content-on-light` (white primary buttons with white labels) or be
 * erased by a color class (controls inheriting the browser's 16px default).
 */
const mergeDesignClasses = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-minimal", "text-compact", "text-regular", "text-comfortable"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeDesignClasses(clsx(inputs));
}
