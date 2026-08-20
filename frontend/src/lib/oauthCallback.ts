// One-slot bridge between the macOS deep-link handler and the login surface.
// It covers both warm callbacks and a cold launch where the URL arrives before
// LoginPage has mounted its listener.

let pendingCode: string | null = null;
let pendingLinkedProvider: OAuthLinkProvider | null = null;
const listeners = new Set<(code: string) => void>();
const linkedListeners = new Set<(provider: OAuthLinkProvider) => void>();

export type OAuthLinkProvider = "google" | "github";

export function acceptOAuthDeepLink(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "cheers:" || parsed.host !== "auth" || parsed.pathname !== "/callback") {
    return false;
  }
  const code = parsed.searchParams.get("code");
  if (code) {
    if (listeners.size === 0) pendingCode = code;
    else listeners.forEach((listener) => listener(code));
    return true;
  }
  const linked = parsed.searchParams.get("linked");
  if (linked === "google" || linked === "github") {
    if (linkedListeners.size === 0) pendingLinkedProvider = linked;
    else linkedListeners.forEach((listener) => listener(linked));
  }
  return true;
}

export function onOAuthHandoff(listener: (code: string) => void): () => void {
  listeners.add(listener);
  if (pendingCode) {
    const code = pendingCode;
    pendingCode = null;
    queueMicrotask(() => listener(code));
  }
  return () => listeners.delete(listener);
}

export function onOAuthLinked(
  listener: (provider: OAuthLinkProvider) => void
): () => void {
  linkedListeners.add(listener);
  if (pendingLinkedProvider) {
    const provider = pendingLinkedProvider;
    pendingLinkedProvider = null;
    queueMicrotask(() => listener(provider));
  }
  return () => linkedListeners.delete(listener);
}
