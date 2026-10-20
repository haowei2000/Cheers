import { ResourceError } from "../hooks/useChatRealtime";
import { merge3Way } from "./collab";
import {
  adoptText, canEditData, canPatch, editData, editText, emptyBuffer, errMsg,
  patchData, patchWithVersionCheck,
  type FileSession, type FileSessionOptions,
} from "./fileBuffer";
import { fileResourceStore } from "./fileResource";
import type { FileContent, FsClient } from "./fsClient";
import type { PatchOp } from "./patchOps";
import { clientSessionGeneration } from "@/lib/clientSession";

type SessionState = Omit<FileSession,
  "setStatus" | "editText" | "setData" | "applyOps" | "save" | "reload" | "setAutoSave" | "resolveConflict">;


/** One controller owns one resource for the lifetime of its authorized FsClient.
 * Rendering, changing tabs and changing navigation modes do not own writes. */
export function createFileSessionController(fs: FsClient, path: string, options?: FileSessionOptions) {
  const epoch = clientSessionGeneration();
  let disposed = false;
  const isCurrent = () => !disposed && epoch === clientSessionGeneration();
  const resources = fileResourceStore(fs);
  let state: SessionState = {
    ...emptyBuffer(path), path, version: null, status: null, saving: false,
    autoSave: options?.autoSave ?? true, conflictNotice: null,
  };
  let baseText = "";
  let editGeneration = 0;
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let resourceUnsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  let pendingOperation: Promise<void> | undefined;
  let pendingLoad: Promise<void> | undefined;
  const delayMs = options?.autoSaveDelayMs ?? 800;

  const update = (next: Partial<SessionState>) => {
    if (!isCurrent()) return;
    state = { ...state, ...next };
    listeners.forEach((notify) => notify());
  };
  const clearAutoSave = () => {
    if (autoSaveTimer !== undefined) clearTimeout(autoSaveTimer);
    autoSaveTimer = undefined;
  };
  const detachIfIdle = () => {
    if (!listeners.size && !state.dirty && !pendingOperation && autoSaveTimer === undefined) {
      resourceUnsubscribe?.();
      resourceUnsubscribe = undefined;
    }
  };
  const adopt = (file: FileContent) => {
    baseText = file.content;
    update({ ...adoptText(path, state, file.content), resourceUri: file.uri, version: file.version, conflictNotice: null });
  };
  const synchronizeSnapshot = () => {
      const snapshot = resources.snapshot(path);
      if (snapshot.loading || state.dirty || state.saving) return;
      if (snapshot.file && snapshot.file.version !== state.version) adopt(snapshot.file);
      else if (snapshot.error) {
        if (snapshot.error instanceof ResourceError && snapshot.error.code === "NOT_FOUND") {
          baseText = "";
          update({ ...adoptText(path, state, ""), version: null, resourceUri: undefined });
        }
        update({ status: errMsg(snapshot.error) });
      }
  };
  const connectResource = () => {
    resourceUnsubscribe ??= resources.subscribe(path, synchronizeSnapshot);
    synchronizeSnapshot();
  };
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const guarded = () => isCurrent() ? operation() : Promise.resolve();
    const pending = pendingOperation
      ? pendingOperation.catch(() => {}).then(guarded)
      : guarded();
    pendingOperation = pending;
    void pending.finally(() => {
      if (pendingOperation === pending) pendingOperation = undefined;
      detachIfIdle();
    }).catch(() => {});
    return pending;
  };

  const reloadCurrent = async (preserveDraft: boolean) => {
    if (!path) return;
    const generation = editGeneration;
    try {
      const file = await resources.read(path);
      if (!isCurrent()) return;
      // Input entered after a read began always wins over its old completion.
      if (state.dirty && (preserveDraft || generation !== editGeneration)) {
        const merged = merge3Way(baseText, state.text, file.content);
        if (merged.hasConflict) {
          update({ conflictNotice: {
            baseText, localText: state.text, remoteText: file.content, conflictsCount: merged.conflictsCount,
          }, status: "Collaborator edited this file — conflict detected" });
        } else {
          baseText = file.content;
          const buffer = editText(path, state, merged.merged);
          update({ ...buffer, dirty: merged.merged !== file.content, resourceUri: file.uri,
            version: file.version, conflictNotice: null, status: "Synced with collaborator" });
          if (state.dirty) scheduleAutoSave();
        }
      } else adopt(file);
    } catch (error) {
      if (error instanceof ResourceError && error.code === "NOT_FOUND") {
        if (state.dirty && (preserveDraft || generation !== editGeneration)) return;
        baseText = "";
        update({ ...adoptText(path, state, ""), resourceUri: undefined, version: null, conflictNotice: null });
      } else update({ status: errMsg(error) });
    }
  };

  const acknowledge = (text: string, version: number, authoredText: string, generation: number) => {
    if (!isCurrent()) return;
    const file = { path, content: text, version, is_dir: false, uri: state.resourceUri };
    if (generation === editGeneration) adopt(file);
    else {
      // A merge retry may add remote edits while the person continues typing.
      // Rebase those newer keystrokes rather than clearing or replacing them.
      const merged = merge3Way(authoredText, state.text, text);
      baseText = text;
      if (merged.hasConflict) {
        update({ version, conflictNotice: {
          baseText: authoredText, localText: state.text, remoteText: text, conflictsCount: merged.conflictsCount,
        }, status: "Saved the earlier edit — review the newer conflicting changes" });
      } else update({ ...editText(path, state, merged.merged), dirty: merged.merged !== text,
        version, conflictNotice: null });
    }
    resources.publish(path, file);
    update({ status: state.dirty ? state.status : "Saved" });
  };

  const saveCurrent = async () => {
    if (!path || (!state.dirty && state.version !== null)) return;
    clearAutoSave();
    update({ saving: true, status: null });
    const text = state.text;
    const generation = editGeneration;
    try {
      const receipt = await fs.write(path, text, state.version ?? 0);
      acknowledge(text, receipt.version, text, generation);
    } catch (error) {
      if (error instanceof ResourceError && error.code === "VERSION_CONFLICT") {
        if (!isCurrent()) return;
        try {
          const latest = await resources.read(path);
          if (!isCurrent()) return;
          const localText = state.text;
          const retryGeneration = editGeneration;
          const merged = merge3Way(baseText, localText, latest.content);
          if (merged.hasConflict) {
            update({ conflictNotice: { baseText, localText, remoteText: latest.content,
              conflictsCount: merged.conflictsCount }, status: "Conflict — remote changes conflict with local edits" });
          } else {
            const receipt = await fs.write(path, merged.merged, latest.version);
            acknowledge(merged.merged, receipt.version, localText, retryGeneration);
          }
        } catch (retryError) {
          // A failed retry must retain the draft; a reload here used to discard it.
          update({ status: errMsg(retryError) });
        }
      } else update({ status: errMsg(error) });
    } finally {
      update({ saving: false });
    }
  };
  const save = () => enqueue(saveCurrent);
  function scheduleAutoSave() {
    clearAutoSave();
    if (!isCurrent() || !state.dirty) return;
    connectResource();
    if (!state.autoSave || state.conflictNotice) return;
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined;
      void save();
    }, delayMs);
  }

  const actions: Pick<FileSession,
    "setStatus" | "editText" | "setData" | "applyOps" | "save" | "reload" | "setAutoSave" | "resolveConflict"> = {
    setStatus: (status) => update({ status }),
    editText: (text) => {
      editGeneration++;
      update(editText(path, state, text));
      scheduleAutoSave();
    },
    setData: (data) => {
      if (!canEditData(state)) { update({ status: "Fix the syntax error in Raw before editing the preview" }); return; }
      try {
        const buffer = editData(path, state, data);
        editGeneration++;
        update(buffer);
        scheduleAutoSave();
      } catch (error) { update({ status: errMsg(error) }); }
    },
    save,
    reload: (skipIfDirty = false) => enqueue(() => reloadCurrent(skipIfDirty)),
    setAutoSave: (autoSave) => {
      update({ autoSave });
      if (autoSave) scheduleAutoSave(); else clearAutoSave();
    },
    applyOps: (ops: readonly PatchOp[]) => {
      if (!ops.length) return Promise.resolve();
      const version = state.version;
      const generation = editGeneration;
      return enqueue(async () => {
        if (version === null) { update({ status: "Cannot patch a file that does not exist yet" }); return; }
        if (!canPatch(state) || state.version !== version || editGeneration !== generation) {
          update({ status: state.parseError ? "Fix the syntax error in Raw first" : "The document changed — review it before repeating your change" });
          return;
        }
        update({ ...patchData(state, ops), status: null, saving: true });
        try {
          await patchWithVersionCheck(fs, path, ops, version);
          update({ status: "Saved" });
        } catch (error) {
          update({ status: error instanceof ResourceError && error.code === "VERSION_CONFLICT"
            ? "Conflict — reloaded the latest version; please repeat your change" : errMsg(error) });
        } finally {
          await reloadCurrent(true);
          update({ saving: false });
        }
      });
    },
    resolveConflict: (choice) => enqueue(async () => {
      const conflict = state.conflictNotice;
      if (!conflict || !path) return;
      if (choice === "remote") {
        const generation = editGeneration;
        try {
          const latest = await resources.read(path);
          if (!isCurrent()) return;
          if (generation === editGeneration) adopt(latest);
          else update({ status: "Newer edits kept — choose again after reviewing them" });
        } catch (error) { update({ status: errMsg(error) }); }
      } else if (choice === "local") {
        update({ saving: true });
        try {
          const latest = await resources.read(path);
          if (!isCurrent()) return;
          const text = state.text;
          const generation = editGeneration;
          const receipt = await fs.write(path, text, latest.version);
          acknowledge(text, receipt.version, text, generation);
        } catch (error) { update({ status: errMsg(error) }); }
        finally { update({ saving: false }); }
      } else {
        const merged = merge3Way(conflict.baseText, state.text, conflict.remoteText);
        editGeneration++;
        update({ ...editText(path, state, merged.merged), conflictNotice: null,
          status: "Conflict markers inserted; please resolve in Raw editor" });
      }
    }),
  };

  return {
    snapshot: () => state,
    subscribe(notify: () => void) {
      listeners.add(notify);
      connectResource();
      return () => { listeners.delete(notify); detachIfIdle(); };
    },
    ensureLoaded() {
      // A signal may have arrived while no view was mounted. Returning to a clean
      // file revalidates, while a retained dirty draft merges against that read.
      if (!path || !isCurrent()) return Promise.resolve();
      pendingLoad ??= enqueue(() => reloadCurrent(true)).finally(() => { pendingLoad = undefined; });
      return pendingLoad;
    },
    actions,
    idle: () => !listeners.size && !state.dirty && !pendingOperation && autoSaveTimer === undefined,
    dispose() { disposed = true; clearAutoSave(); resourceUnsubscribe?.(); resourceUnsubscribe = undefined; },
  };
}

const sessions = new WeakMap<FsClient, { generation: number; entries: Map<string, ReturnType<typeof createFileSessionController>> }>();
export function fileSessionController(fs: FsClient, path: string, options?: FileSessionOptions) {
  let scope = sessions.get(fs);
  if (!scope || scope.generation !== clientSessionGeneration()) {
    scope = { generation: clientSessionGeneration(), entries: new Map() };
    sessions.set(fs, scope);
  }
  const entries = scope.entries;
  let controller = entries.get(path);
  if (!controller) {
    controller = createFileSessionController(fs, path, options);
    entries.set(path, controller);
  }
  if (entries.size > 128) for (const [key, value] of entries) {
    if (key !== path && value.idle()) { value.dispose(); entries.delete(key); }
    if (entries.size <= 128) break;
  }
  return controller;
}
