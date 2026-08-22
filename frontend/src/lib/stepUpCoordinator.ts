import { useSyncExternalStore } from "react";

export class StepUpCancelledError extends Error {
  readonly code = "step_up_cancelled";

  constructor(message = "Identity confirmation was cancelled") {
    super(message);
    this.name = "StepUpCancelledError";
  }
}

type PendingStepUp = {
  id: number;
  actionClass: string;
  waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
};

let pending: PendingStepUp | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function requestStepUp(actionClass = "sensitive_action"): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pending) {
      if (pending.actionClass !== actionClass) pending.actionClass = "multiple_sensitive_actions";
      pending.waiters.push({ resolve, reject });
      return;
    }
    pending = { id: nextId++, actionClass, waiters: [{ resolve, reject }] };
    emit();
  });
}

export function completeStepUp(): void {
  const current = pending;
  if (!current) return;
  pending = null;
  current.waiters.forEach(({ resolve }) => resolve());
  emit();
}

export function cancelStepUp(error = new StepUpCancelledError()): void {
  const current = pending;
  if (!current) return;
  pending = null;
  current.waiters.forEach(({ reject }) => reject(error));
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number | null {
  return pending?.id ?? null;
}

export function usePendingStepUpId(): number | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

export function hasPendingStepUp(): boolean {
  return pending !== null;
}

export function pendingStepUpActionClass(): string {
  return pending?.actionClass ?? "sensitive_action";
}
