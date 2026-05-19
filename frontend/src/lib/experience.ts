export const BEGINNER_MODE_KEY = "agentnexus-beginner-mode";

export function getStoredBeginnerMode(): boolean {
  try {
    return localStorage.getItem(BEGINNER_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setStoredBeginnerMode(enabled: boolean): void {
  try {
    localStorage.setItem(BEGINNER_MODE_KEY, enabled ? "1" : "0");
  } catch {
    // Local storage can be unavailable in privacy-restricted contexts.
  }
}
