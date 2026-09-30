import { useCallback, useEffect, useMemo, useState } from "react";
import type { FsClient } from "./fsClient";
import { errMsg } from "./jsonFile";
import { WORKBENCH_CONFIG_PATH } from "./environmentRegistry";
import { seedManifest, viewOf, type TemplateManifest } from "./manifest";
import { listOfficialScenes } from "./extensions/api";
import { parsePersonalExtension } from "./extensions/parseOffThread";
import { isPersonalExtensionDisabled } from "./extensions/runtime";
import type { RendererExtension } from "./sandbox/rendererExtension";
import { listPersonalExtensions } from "@/lib/desktop";
import { parseLocator } from "../locator";
import {
  WB_DOC,
  appendCollectionTab,
  parseCfg,
  sceneBelongsToExtension,
  type WbConfig,
  type WorkbenchSceneState,
} from "./workbenchConfig";

export interface UseWorkbenchDrawerStateOptions {
  open: boolean;
  channelId: string;
  fs: FsClient;
  openFilePath?: string;
}

export function useWorkbenchDrawerState({
  open,
  channelId,
  fs,
  openFilePath,
}: UseWorkbenchDrawerStateOptions) {
  const [cfg, setCfg] = useState<WbConfig>({});
  const [globalTemplates, setGlobalTemplates] = useState<TemplateManifest[]>([]);
  const [personalTemplates, setPersonalTemplates] = useState<TemplateManifest[]>([]);
  const [sessionTemplates, setSessionTemplates] = useState<TemplateManifest[]>([]);
  const [personalRendererExtensions, setPersonalRendererExtensions] = useState<RendererExtension[]>([]);
  const [sessionRendererExtensions, setSessionRendererExtensions] = useState<RendererExtension[]>([]);
  const [extensionsRevision, setExtensionsRevision] = useState(0);

  const localBindingKey = `cheers.workbench.personal-bindings.${channelId}`;
  const [localBindings, setLocalBindings] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(localBindingKey) ?? "{}");
    } catch {
      return {};
    }
  });

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rawMode, setRawMode] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);

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
    if (openFilePath) {
      const locator = openFilePath.startsWith("cheers:") ? parseLocator(openFilePath) : null;
      setFocus(locator?.kind === "desk" ? locator.path : openFilePath);
    }
  }, [openFilePath]);

  // Never leak a focus/selection across channels.
  useEffect(() => setFocus(null), [channelId]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    fs.read(WORKBENCH_CONFIG_PATH)
      .then((f) => alive && setCfg(parseCfg(f.content)))
      .catch(() => alive && setCfg({}));
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

  useEffect(() => {
    try {
      setLocalBindings(JSON.parse(localStorage.getItem(localBindingKey) ?? "{}"));
    } catch {
      setLocalBindings({});
    }
  }, [localBindingKey]);

  const writeCfg = useCallback(
    async (next: WbConfig) => {
      const prev = cfg;
      setCfg(next);
      try {
        const { _doc: _drop, ...rest } = next;
        const body = { _doc: WB_DOC, ...rest };
        await fs.write(WORKBENCH_CONFIG_PATH, JSON.stringify(body, null, 2));
      } catch (e) {
        setCfg((c) => (c === next ? prev : c));
        setNotice(errMsg(e));
      }
    },
    [cfg, fs]
  );

  const pinned = useMemo(() => cfg.pinned ?? [], [cfg.pinned]);
  const togglePin = useCallback(
    (path: string) => {
      const set = new Set(pinned);
      if (set.has(path)) set.delete(path);
      else set.add(path);
      void writeCfg({ ...cfg, pinned: [...set] });
    },
    [cfg, pinned, writeCfg]
  );

  const bindings = useMemo(
    () => ({ ...(cfg.bindings ?? {}), ...localBindings }),
    [cfg.bindings, localBindings]
  );

  const setBinding = useCallback(
    (path: string, rendererId: string | null) => {
      if (rendererId?.startsWith("personal:")) {
        const next = { ...localBindings, [path]: rendererId };
        setLocalBindings(next);
        localStorage.setItem(localBindingKey, JSON.stringify(next));
        const shared = { ...(cfg.bindings ?? {}) };
        delete shared[path];
        void writeCfg({ ...cfg, bindings: shared });
      } else {
        const local = { ...localBindings };
        delete local[path];
        setLocalBindings(local);
        localStorage.setItem(localBindingKey, JSON.stringify(local));
        const shared = { ...(cfg.bindings ?? {}) };
        if (rendererId) shared[path] = rendererId;
        else delete shared[path];
        void writeCfg({ ...cfg, bindings: shared });
      }
    },
    [cfg, localBindings, localBindingKey, writeCfg]
  );

  const configs = useMemo(() => cfg.configs ?? {}, [cfg.configs]);

  const activate = useCallback(
    async (manifest: TemplateManifest): Promise<boolean> => {
      setBusy(true);
      try {
        await seedManifest(fs, manifest);
        let base = cfg;
        try {
          base = parseCfg((await fs.read(WORKBENCH_CONFIG_PATH)).content);
        } catch {
          /* no config file yet — keep the in-memory snapshot */
        }
        const nextBindings = { ...(base.bindings ?? {}) };
        const nextConfigs = { ...(base.configs ?? {}) };
        for (const item of manifest.items) {
          const path = item.source.path;
          const view = viewOf(item);
          if (view.startsWith("personal:")) {
            setLocalBindings((current) => {
              if (current[path]) return current;
              const next = { ...current, [path]: view };
              localStorage.setItem(localBindingKey, JSON.stringify(next));
              return next;
            });
          } else if (!nextBindings[path] && view !== "auto") nextBindings[path] = view;
          if (item.config !== undefined && nextConfigs[path] === undefined) nextConfigs[path] = item.config;
        }
        const sceneState: WorkbenchSceneState = {
          version: 1,
          order: [...(base.scene_state?.order ?? []).filter((id) => id !== manifest.id), manifest.id],
          titles: { ...(base.scene_state?.titles ?? {}), [manifest.id]: manifest.title },
          items: {
            ...(base.scene_state?.items ?? {}),
            [manifest.id]: manifest.items.map((item) => item.source.path),
          },
        };
        const next: WbConfig = {
          ...base,
          environment: manifest.id,
          bindings: nextBindings,
          configs: nextConfigs,
          scene_state: sceneState,
        };
        if (manifest.pin?.length) next.pinned = [...new Set([...(base.pinned ?? []), ...manifest.pin])];
        await writeCfg(next);
        setFocus(manifest.items[0]?.source.path ?? null);
        return true;
      } catch (e) {
        setNotice(errMsg(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fs, cfg, writeCfg, localBindingKey]
  );

  const addTab = useCallback(
    async (collectionId: string, path: string): Promise<boolean> => {
      setBusy(true);
      try {
        let base = cfg;
        try {
          base = parseCfg((await fs.read(WORKBENCH_CONFIG_PATH)).content);
        } catch {
          /* no config file yet — keep the in-memory snapshot */
        }
        const nextState = appendCollectionTab(base.scene_state, collectionId, path);
        if (nextState !== base.scene_state) await writeCfg({ ...base, scene_state: nextState });
        setFocus(path);
        return true;
      } catch (error) {
        setNotice(errMsg(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [cfg, fs, writeCfg]
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
    bindings,
    setBinding,
    configs,
    activate,
    addTab,
    allEnvs,
    rendererExtensions,
    selectedId: cfg.environment ?? null,
  };
}
