import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ArtifactReference, ArtifactReferenceStore } from "./referenceStore";

const NONE: ArtifactReference = { loading: false };

export function useArtifactReference(store: ArtifactReferenceStore | undefined, id: string | undefined): ArtifactReference {
  const subscribe = useCallback(
    (notify: () => void) => (store && id ? store.subscribe(id, notify) : () => {}),
    [store, id],
  );
  const snapshot = () => (store && id ? store.snapshot(id) : NONE);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Watch several references at once; read each with `store.snapshot(id)` during render. */
export function useArtifactReferences(store: ArtifactReferenceStore | undefined, ids: string): void {
  const subscribe = useCallback((notify: () => void) => {
    if (!store || !ids) return () => {};
    const stops = ids.split(",").map((id) => store.subscribe(id, notify));
    return () => stops.forEach((stop) => stop());
  }, [store, ids]);
  const revision = () => store?.revision() ?? 0;
  useSyncExternalStore(subscribe, revision, revision);
}

/** The host that sees file changes reports them; lenses and cards only subscribe. */
export function useArtifactInvalidation(store: ArtifactReferenceStore | undefined, filesTick: number | undefined): void {
  useEffect(() => {
    if (store && filesTick !== undefined) store.invalidate(filesTick);
  }, [store, filesTick]);
}
