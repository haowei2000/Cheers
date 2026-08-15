const DRAFT_PREFIX = "cheers.draft.";

/** Removes sensitive tab-scoped data before another account can use this tab. */
export function clearClientSessionData(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(DRAFT_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; the in-memory event still clears live drafts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("cheers:session-cleared"));
  }
}
