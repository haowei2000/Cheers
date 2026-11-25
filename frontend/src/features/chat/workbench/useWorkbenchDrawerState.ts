import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsClient } from "./fsClient";
import { errMsg } from "./jsonFile";
import { seedManifest, type TemplateManifest } from "./manifest";
import { listOfficialScenes } from "./extensions/api";
import { parsePersonalExtension } from "./extensions/parseOffThread";
import { isPersonalExtensionDisabled } from "./extensions/runtime";
import type { RendererExtension } from "./sandbox/rendererExtension";
import { listPersonalExtensions } from "@/lib/desktop";
import { parseLocator } from "../locator";
import {
  appendCollectionTab,
  parseCfg,
  sceneBelongsToExtension,
  type WorkbenchSceneState,
} from "./workbenchConfig";
import { mutateWorkbenchConfiguration, useWorkbenchConfiguration, type WorkbenchDocument } from "./workbenchConfiguration";
import { clientSessionGeneration } from "@/lib/clientSession";
import { resolveWorkbenchTarget } from "./channelFileClient";

export interface UseWorkbenchDrawerStateOptions {
  open: boolean;
  channelId: string;
  fs: FsClient;
  openFilePath?: string;
  filesTick?: number;
}

export function useWorkbenchDrawerState({
  open,
  channelId,
  fs,
  openFilePath,
  filesTick,
}: UseWorkbenchDrawerStateOptions) {
  const configuration = useWorkbenchConfiguration(fs, open, filesTick);
  const cfg = useMemo(() => parseCfg(JSON.stringify(configuration.document ?? {})), [configuration.document]);
  const [globalTemplates, setGlobalTemplates] = useState<TemplateManifest[]>([]);
  const [personalTemplates, setPersonalTemplates] = useState<TemplateManifest[]>([]);
  const [sessionTemplates, setSessionTemplates] = useState<TemplateManifest[]>([]);
  const [personalRendererExtensions, setPersonalRendererExtensions] = useState<RendererExtension[]>([]);
  const [sessionRendererExtensions, setSessionRendererExtensions] = useState<RendererExtension[]>([]);
  const [extensionsRevision, setExtensionsRevision] = useState(0);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const scope = useRef({ fs, channelId });
  scope.current = { fs, channelId };
  const captureScope = useCallback(() => {
    const generation = clientSessionGeneration();
    return () => scope.current.fs === fs && scope.current.channelId === channelId && generation === clientSessionGeneration();
  }, [fs, channelId]);

  useEffect(() => {
    setBusy(false);
    setNotice(null);
  }, [fs, channelId]);

  useEffect(() => {
    const error = configuration.error;
    if (error && !(error instanceof Error && "code" in error && error.code === "NOT_FOUND")) setNotice(errMsg(error));
  }, [configuration.error]);

  useEffect(() => {
    const changed = () => setExtensionsRevision((revision) => revision + 1);
    const removed = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail.id;
      setSessionTemplates((current) => current.filter((scene) => !sceneBelongsToExtension(scene.id, id)));
      setSessionRendererExtensions((current) => current.filter((extension) => extension.extensionId !== id));
    };
    window.addEventListener("cheers:extensions-changed", changed);
    window.addEventListener("cheers:temporary-extension-removed", removed);
    return () => {
      window.removeEventListener("cheers:extensions-changed", changed);
      window.removeEventListener("cheers:temporary-extension-removed", removed);
    };
  }, []);

  useEffect(() => {
    let active=true;
    const current = captureScope();
    if (openFilePath) {
      const locator = openFilePath.startsWith("cheers:") ? parseLocator(openFilePath) : null;
      if(locator?.kind==="resource") {
        setFocus(null);
        void resolveWorkbenchTarget(openFilePath, channelId)
          .then(resource => { if (active && current()) setFocus(resource.path); })
          .catch(error => { if (active && current()) setNotice(errMsg(error)); });
      } else setFocus(locator?.kind === "desk" ? locator.path : openFilePath);
    }
    return()=>{active=false;};
  }, [openFilePath, channelId, captureScope]);

  // Never leak a focus/selection across channels.
  useEffect(() => {
    setFocus(null);
  }, [channelId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    listOfficialScenes()
      .then((t) => alive && setGlobalTemplates(t))
      .catch(() => {});
    listPersonalExtensions()
      .then((ps) => {
        if (!alive) return;
        return Promise.all(ps.map(parsePersonalExtension)).then((extensions) => {
          if (!alive) return;
          const enabled = extensions.filter((extension) => !isPersonalExtensionDisabled(extension.manifest.id));
          setPersonalRendererExtensions(
            enabled.flatMap((extension) => (extension.rendererExtension ? [extension.rendererExtension] : []))
          );
          setPersonalTemplates(enabled.flatMap((extension) => extension.scenes));
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open, fs, channelId, extensionsRevision]);

  const mutateCfg = useCallback(
    async (mutate: (document: WorkbenchDocument) => void | false) => {
      const current = captureScope();
      try {
        return await mutateWorkbenchConfiguration(fs, mutate);
      } catch (e) {
        if (current()) setNotice(errMsg(e));
        throw e;
      }
    },
    [fs, captureScope]
  );

  const pinned = useMemo(() => cfg.pinned ?? [], [cfg.pinned]);
  const togglePin = useCallback(
    (path: string) => {
      void mutateCfg((document) => {
        const set = new Set(parseCfg(JSON.stringify(document)).pinned ?? []);
        if (set.has(path)) set.delete(path);
        else set.add(path);
        document.pinned = [...set];
      }).catch(() => {});
    },
    [mutateCfg]
  );

  const activate = useCallback(
    async (manifest: TemplateManifest): Promise<boolean> => {
      const current = captureScope();
      setBusy(true);
      try {
        await seedManifest(fs, manifest);
        await mutateCfg((document) => {
          const base = parseCfg(JSON.stringify(document));
          const sceneState: WorkbenchSceneState = {
            version: 1,
            order: [...(base.scene_state?.order ?? []).filter((id) => id !== manifest.id), manifest.id],
            titles: { ...(base.scene_state?.titles ?? {}), [manifest.id]: manifest.title },
            items: {
              ...(base.scene_state?.items ?? {}),
              [manifest.id]: manifest.items.map((item) => item.source.path),
            },
          };
          Object.assign(document, { environment: manifest.id, scene_state: sceneState });
          if (manifest.pin?.length) document.pinned = [...new Set([...(base.pinned ?? []), ...manifest.pin])];
        });
        if (current()) setFocus(manifest.items[0]?.source.path ?? null);
        return current();
      } catch (e) {
        if (current()) setNotice(errMsg(e));
        return false;
      } finally {
        if (current()) setBusy(false);
      }
    },
    [fs, mutateCfg, captureScope]
  );

  const addTab = useCallback(
    async (collectionId: string, path: string): Promise<boolean> => {
      const current = captureScope();
      setBusy(true);
      try {
        await mutateCfg((document) => {
          const base = parseCfg(JSON.stringify(document));
          const nextState = appendCollectionTab(base.scene_state, collectionId, path);
          if (nextState === base.scene_state) return false;
          document.scene_state = nextState;
        });
        if (current()) setFocus(path);
        return current();
      } catch (error) {
        if (current()) setNotice(errMsg(error));
        return false;
      } finally {
        if (current()) setBusy(false);
      }
    },
    [mutateCfg, captureScope]
  );

  const allEnvs = useMemo(() => {
    const byId = new Map<string, TemplateManifest>();
    for (const e of [...sessionTemplates, ...personalTemplates, ...globalTemplates]) {
      if (!byId.has(e.id)) byId.set(e.id, e);
    }
    return [...byId.values()];
  }, [sessionTemplates, personalTemplates, globalTemplates]);

  const rendererExtensions = useMemo(() => {
    const byId = new Map<string, RendererExtension>();
    for (const p of [...sessionRendererExtensions, ...personalRendererExtensions]) {
      if (!byId.has(p.extensionId)) byId.set(p.extensionId, p);
    }
    return [...byId.values()];
  }, [sessionRendererExtensions, personalRendererExtensions]);

  return {
    cfg,
    busy,
    notice,
    setNotice,
    rawMode,
    setRawMode,
    focus,
    pinned,
    togglePin,
    activate,
    addTab,
    allEnvs,
    rendererExtensions,
    selectedId: cfg.environment ?? null,
  };
}
