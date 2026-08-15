import type { ParsedExtension } from "./package";

export type ExtensionRuntimeStatus = "ready" | "running" | "failed";

export interface TemporaryExtensionState {
  extension: ParsedExtension;
  status: ExtensionRuntimeStatus;
  error?: string;
}

const DISABLED_KEY = "cheers.workbench.disabled-personal-extensions";
const temporary = new Map<string, TemporaryExtensionState>();
const personalStatus = new Map<string, { status: ExtensionRuntimeStatus; error?: string }>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function readDisabled(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(DISABLED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function subscribeExtensionRuntime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isPersonalExtensionDisabled(id: string): boolean {
  return readDisabled().has(id);
}

export function setPersonalExtensionDisabled(id: string, disabled: boolean): void {
  const ids = readDisabled();
  if (disabled) ids.add(id);
  else ids.delete(id);
  personalStatus.delete(id);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(DISABLED_KEY, JSON.stringify([...ids].sort()));
    window.dispatchEvent(new Event("cheers:extensions-changed"));
  }
  emit();
}

export function reportRendererStatus(
  extensionId: string,
  status: ExtensionRuntimeStatus,
  error?: string
): void {
  const next = { status, error };
  if (temporary.has(extensionId)) {
    temporary.set(extensionId, { ...temporary.get(extensionId)!, ...next });
  } else {
    personalStatus.set(extensionId, next);
  }
  emit();
}

export function personalExtensionStatus(id: string): { status: ExtensionRuntimeStatus; error?: string } {
  return personalStatus.get(id) ?? { status: "ready" };
}

export function registerTemporaryExtension(extension: ParsedExtension): void {
  temporary.set(extension.manifest.id, { extension, status: "ready" });
  emit();
}

export function removeTemporaryExtension(id: string): void {
  if (!temporary.delete(id)) return;
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cheers:temporary-extension-removed", { detail: { id } }));
  emit();
}

export function listTemporaryExtensions(): TemporaryExtensionState[] {
  return [...temporary.values()].sort((left, right) =>
    left.extension.manifest.title.localeCompare(right.extension.manifest.title)
  );
}
