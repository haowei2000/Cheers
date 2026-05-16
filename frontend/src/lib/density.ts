export type Density = "comfy" | "compact";

export const DENSITY_KEY = "agentnexus-density";

export function getStoredDensity(): Density {
  if (typeof window === "undefined") return "comfy";
  const v = localStorage.getItem(DENSITY_KEY);
  return v === "compact" ? "compact" : "comfy";
}

export function applyDensity(d: Density) {
  document.documentElement.setAttribute("data-density", d);
}
