export const BEGINNER_MODE_KEY = "agentnexus-beginner-mode";

export function getStoredBeginnerMode(): boolean {
  try {
    const stored = localStorage.getItem(BEGINNER_MODE_KEY);
    if (stored === null) return true;
    return stored === "1";
  } catch {
    return true;
  }
}

export function setStoredBeginnerMode(enabled: boolean): void {
  try {
    localStorage.setItem(BEGINNER_MODE_KEY, enabled ? "1" : "0");
  } catch {
    // Local storage can be unavailable in privacy-restricted contexts.
  }
}
