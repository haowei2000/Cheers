import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ResourceError } from "../hooks/useChatRealtime";
import { fileResourceStore } from "./fileResource";
import type { FsClient } from "./fsClient";
import { WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { WB_DOC } from "./workbenchConfig";
import { clientSessionGeneration } from "@/lib/clientSession";

export type WorkbenchDocument = Record<string, unknown>;

function parseDocument(content: string): WorkbenchDocument {
  const value: unknown = JSON.parse(content);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workbench configuration must be a JSON object.");
  }
  return value as WorkbenchDocument;
}

const pendingMutations = new WeakMap<FsClient, { generation: number; promise: Promise<WorkbenchDocument> }>();

/** Every owner edits the latest raw document through the same CAS boundary.
 * Replaying a field mutation preserves unrelated and future-schema fields. */
export function mutateWorkbenchConfiguration(
  fs: Pick<FsClient, "read" | "write">,
  mutate: (document: WorkbenchDocument) => void | false,
): Promise<WorkbenchDocument> {
  // Production callers share the channel FsClient; the narrow type also permits
  // exercising the transaction independently of the resource transport.
  const client = fs as FsClient;
  const generation = clientSessionGeneration();
  const assertSession = () => {
    if (generation !== clientSessionGeneration()) throw new ResourceError("DISCONNECTED", "Your session changed. Reopen the Workbench before editing.");
  };
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      assertSession();
      let document: WorkbenchDocument = {};
      let version = 0;
      try {
        const file = await fs.read(WORKBENCH_CONFIG_PATH);
        document = parseDocument(file.content);
        version = file.version;
      } catch (error) {
        if (!(error instanceof ResourceError && error.code === "NOT_FOUND")) throw error;
      }
      assertSession();
      if (mutate(document) === false) {
        fileResourceStore(client).publish(WORKBENCH_CONFIG_PATH, {
          path: WORKBENCH_CONFIG_PATH, content: JSON.stringify(document), version, is_dir: false,
        });
        return document;
      }
      document._doc = WB_DOC;
      const content = JSON.stringify(document, null, 2);
      try {
        assertSession();
        const receipt = await fs.write(WORKBENCH_CONFIG_PATH, content, version);
        assertSession();
        fileResourceStore(client).publish(WORKBENCH_CONFIG_PATH, {
          path: WORKBENCH_CONFIG_PATH, content, version: receipt.version, is_dir: false,
        });
        return document;
      } catch (error) {
        if (!(error instanceof ResourceError && error.code === "VERSION_CONFLICT") || attempt >= 2) throw error;
      }
    }
  };
  const previous = pendingMutations.get(client);
  const pending = previous?.generation === generation ? previous.promise.catch(() => undefined).then(run) : run();
  pendingMutations.set(client, { generation, promise: pending });
  void pending.finally(() => {
    if (pendingMutations.get(client)?.promise === pending) pendingMutations.delete(client);
  }).catch(() => {});
  return pending;
}

export function refreshWorkbenchConfiguration(fs: FsClient, filesTick: number) {
  return fileResourceStore(fs).refresh(WORKBENCH_CONFIG_PATH, filesTick);
}

/** Drawer and layout consumers subscribe to the same authorized file snapshot. */
export function useWorkbenchConfiguration(fs: FsClient, enabled: boolean, filesTick?: number) {
  const resources = useMemo(() => fileResourceStore(fs), [fs]);
  const subscription = useMemo(() => ({
    subscribe: (notify: () => void) => resources.subscribe(WORKBENCH_CONFIG_PATH, notify),
    snapshot: () => resources.snapshot(WORKBENCH_CONFIG_PATH),
  }), [resources]);
  const snapshot = useSyncExternalStore(subscription.subscribe, subscription.snapshot, subscription.snapshot);
  useEffect(() => {
    if (enabled) void resources.read(WORKBENCH_CONFIG_PATH).catch(() => {});
  }, [enabled, resources]);
  useEffect(() => {
    if (enabled) void refreshWorkbenchConfiguration(fs, filesTick ?? 0).catch(() => {});
  }, [enabled, filesTick, fs]);
  return useMemo(() => {
    try {
      return { document: snapshot.file ? parseDocument(snapshot.file.content) : undefined, error: snapshot.error };
    } catch (error) {
      return { document: undefined, error };
    }
  }, [snapshot]);
}
