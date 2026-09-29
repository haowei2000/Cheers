export interface RecentWorkspace {
  path: string;
  name: string;
  botId?: string;
  lastUsedAt: number;
}

const STORAGE_KEY = "cheers.recent_workspaces";
const MAX_RECENT = 8;

export function workspaceNameFromPath(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  if (!normalized) return "/";
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function formatWorkspaceDisplayPath(path: string): string {
  return path.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, "~");
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getRecentWorkspaces(): RecentWorkspace[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentWorkspace => Boolean(item && typeof item.path === "string"))
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function addRecentWorkspace(path: string, botId?: string): RecentWorkspace[] {
  const trimmed = path.trim();
  if (!trimmed) return getRecentWorkspaces();
  const storage = getStorage();
  if (!storage) return [];

  try {
    const current = getRecentWorkspaces().filter((w) => w.path !== trimmed);
    const updated: RecentWorkspace = {
      path: trimmed,
      name: workspaceNameFromPath(trimmed),
      botId: botId || undefined,
      lastUsedAt: Date.now(),
    };
    const next = [updated, ...current].slice(0, MAX_RECENT);
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("cheers:recent-workspaces-changed", { detail: next }));
    }
    return next;
  } catch {
    return getRecentWorkspaces();
  }
}

export function removeRecentWorkspace(path: string): RecentWorkspace[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const current = getRecentWorkspaces().filter((w) => w.path !== path.trim());
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("cheers:recent-workspaces-changed", { detail: current }));
    }
    return current;
  } catch {
    return getRecentWorkspaces();
  }
}
