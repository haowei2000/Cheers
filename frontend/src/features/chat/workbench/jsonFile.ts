import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { FsClient } from "./fsClient";
import { fileSessionController } from "./fileSessionController";
import type { FileSession, FileSessionOptions } from "./fileBuffer";

export * from "./fileBuffer";

/** Views subscribe to a resource-owned session. Navigation only detaches a view;
 * the draft, pending autosave and in-flight writes remain with their resource. */
export function useFileSession(fs: FsClient, path: string, options?: FileSessionOptions): FileSession {
  const controller = useMemo(() => fileSessionController(fs, path, options), [fs, path, options]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => { void controller.ensureLoaded(); }, [controller]);
  return useMemo(() => ({ ...state, ...controller.actions }), [state, controller]);
}
