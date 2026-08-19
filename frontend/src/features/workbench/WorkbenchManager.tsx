import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Blocks, CircleCheck, ExternalLink, Laptop, Package, Power, PowerOff, Trash2, Upload, X } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { Banner } from "@/components/ui/banner";
import { ItemSection, WorkbenchItem } from "@/components/ui/item";
import { useIsAdmin } from "@/stores/authStore";
import { isTauri } from "@/lib/serverConfig";
import {
  downloadCatalogExtension,
  installPersonalExtension,
  listPersonalExtensions,
  removePersonalExtension,
} from "@/lib/desktop";
import {
  deleteExtension,
  installGlobalExtension,
  listExtensions,
  type ExtensionSummary,
} from "@/features/chat/workbench/extensions/api";
import {
  permissionSummary,
  type ParsedExtension,
} from "@/features/chat/workbench/extensions/package";
import { parseExtensionPackageOffThread, parsePersonalExtension } from "@/features/chat/workbench/extensions/parseOffThread";
import {
  isPersonalExtensionDisabled,
  listTemporaryExtensions,
  personalExtensionStatus,
  removeTemporaryExtension,
  setPersonalExtensionDisabled,
  subscribeExtensionRuntime,
} from "@/features/chat/workbench/extensions/runtime";
import {
  clearExtensionInstallIntent,
  EXTENSION_INSTALL_EVENT,
  peekExtensionInstallIntent,
} from "@/lib/extensionInstallIntent";
import { ExtensionInstallDialog } from "./ExtensionInstallDialog";
import {
  compareSemver,
  type ExtensionInstallCandidate,
  type InstalledExtensionIdentity,
  type InstallScope,
} from "./extensionInstall";

const OFFICIAL_CATALOG_URL = "https://haowei2000.github.io/Cheers/plugins.html";
const OFFICIAL_CATALOG_JSON_URL = "https://haowei2000.github.io/Cheers/extensions/catalog.json";

export interface CatalogPackageEntry {
  kind: "package";
  id: string;
  version: string;
  publisher: string;
  category: string;
  featured?: boolean;
  title: { en: string; "zh-CN"?: string };
  description: { en: string; "zh-CN"?: string };
  manifestTitle?: string;
  manifestDescription?: string;
  sha256: string;
  downloadPath: string;
  sourceUrl: string;
  globalCapable: boolean;
  contributes: { scenes: number; renderers: number; automations: number };
  permissions: Record<string, unknown>;
}

export interface CatalogData {
  schemaVersion: number;
  publisher: string;
  entries: (CatalogPackageEntry | { kind: "builtin"; id: string; [key: string]: unknown })[];
}

export function WorkbenchManager() {
  const isAdmin = useIsAdmin();
  const desktop = isTauri();
  const [global, setGlobal] = useState<ExtensionSummary[]>([]);
  const [personal, setPersonal] = useState<ParsedExtension[]>([]);
  const [catalogEntries, setCatalogEntries] = useState<CatalogPackageEntry[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoadingState, setCatalogLoadingState] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ExtensionInstallCandidate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [, setRuntimeRevision] = useState(0);
  const globalRef = useRef<HTMLInputElement>(null);
  const personalRef = useRef<HTMLInputElement>(null);
  const catalogLoading = useRef(false);

  const reload = useCallback(async () => {
    try {
      setGlobal(await listExtensions());
      if (desktop) {
        const stored = await listPersonalExtensions();
        const parsed = await Promise.all(
          stored.map(parsePersonalExtension)
        );
        setPersonal(parsed);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [desktop]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let alive = true;
    setCatalogLoadingState(true);
    fetch(OFFICIAL_CATALOG_JSON_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: CatalogData) => {
        if (!alive) return;
        if (Array.isArray(data.entries)) {
          const packages = data.entries.filter((e): e is CatalogPackageEntry => e.kind === "package");
          setCatalogEntries(packages);
        }
      })
      .catch((err) => {
        if (alive) setCatalogError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setCatalogLoadingState(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => subscribeExtensionRuntime(() => setRuntimeRevision((value) => value + 1)), []);

  const prepareFile = useCallback(async (file: File, scope: InstallScope) => {
    setError(null);
    try {
      const extension = await parseExtensionPackageOffThread(await file.arrayBuffer(), scope);
      setCandidate({ extension, scope, source: "file", sourceLabel: file.name });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const prepareCatalogIntent = useCallback(async () => {
    const intent = peekExtensionInstallIntent();
    if (!desktop || !intent || catalogLoading.current) return;
    catalogLoading.current = true;
    setError(null);
    try {
      const bytes = await downloadCatalogExtension(intent.source, intent.sha256);
      const extension = await parseExtensionPackageOffThread(bytes, "personal");
      if (extension.sha256 !== intent.sha256 || extension.manifest.id !== intent.id || extension.manifest.version !== intent.version) {
        throw new Error("Official catalog metadata does not match the downloaded extension");
      }
      setCandidate({ extension, scope: "personal", source: "official-catalog", sourceLabel: "Cheers official catalog" });
      clearExtensionInstallIntent();
    } catch (reason) {
      clearExtensionInstallIntent();
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      catalogLoading.current = false;
    }
  }, [desktop]);

  const installFromCatalog = useCallback(
    async (entry: CatalogPackageEntry, scope: InstallScope) => {
      setError(null);
      try {
        let bytes: Uint8Array;
        if (desktop) {
          bytes = await downloadCatalogExtension(entry.sourceUrl, entry.sha256);
        } else {
          const res = await fetch(entry.sourceUrl);
          if (!res.ok) throw new Error(`Failed to download package: HTTP ${res.status}`);
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        const extension = await parseExtensionPackageOffThread(bytes, scope);
        if (extension.sha256 !== entry.sha256 || extension.manifest.id !== entry.id) {
          throw new Error("Official catalog metadata does not match the downloaded extension");
        }
        setCandidate({ extension, scope, source: "official-catalog", sourceLabel: entry.title.en });
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [desktop]
  );

  useEffect(() => {
    void prepareCatalogIntent();
    const receive = () => void prepareCatalogIntent();
    window.addEventListener(EXTENSION_INSTALL_EVENT, receive);
    return () => window.removeEventListener(EXTENSION_INSTALL_EVENT, receive);
  }, [prepareCatalogIntent]);

  const installed = useMemo<InstalledExtensionIdentity | undefined>(() => {
    if (!candidate) return undefined;
    if (candidate.scope === "global") {
      const match = global.find((extension) => extension.id === candidate.extension.manifest.id);
      return match ? { version: match.version, sha256: match.sha256, permissions: match.permissions } : undefined;
    }
    const match = personal.find((extension) => extension.manifest.id === candidate.extension.manifest.id);
    return match ? { version: match.manifest.version, sha256: match.sha256, permissions: match.manifest.permissions ?? {} } : undefined;
  }, [candidate, global, personal]);

  const confirmInstall = useCallback(async () => {
    if (!candidate || installing) return;
    setInstalling(true);
    setError(null);
    try {
      if (candidate.scope === "global") {
        await installGlobalExtension(candidate.extension.manifest, candidate.extension.bytes);
        setNotice(`Installed globally: ${candidate.extension.manifest.title}`);
      } else {
        await installPersonalExtension(candidate.extension.manifest.id, candidate.extension.bytes, candidate.extension.sha256);
        setNotice(`Installed on this Mac: ${candidate.extension.manifest.title}`);
      }
      setCandidate(null);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInstalling(false);
    }
  }, [candidate, installing, reload]);

  return (
    <section>
      <h2 className="mb-4 flex items-center gap-2 text-compact font-semibold uppercase tracking-section text-content-muted">
        <Blocks className="h-3.5 w-3.5" /> Workbench extensions
      </h2>
      {(error || notice) && (
        <Banner severity={error ? "error" : "success"} icon={error ? AlertCircle : CircleCheck} className="mb-3" onDismiss={() => { setError(null); setNotice(null); }}>
          {error ?? notice}
        </Banner>
      )}
      <ItemSection
        label="Installed extensions"
        presentationLevel="medium"
        controlSize="regular"
        className="border-t border-zinc-800 pt-2"
        description="Scenes and renderers installed from verified packages."
        action={<div className="flex items-center gap-2">
          <UiButton action="open" content="iconText" variant="plain" type="button" controlSize="compact" onClick={() => { const popup = window.open(OFFICIAL_CATALOG_URL, "_blank", "noopener,noreferrer"); if (popup) popup.opener = null; }}>
            <ExternalLink className="h-3.5 w-3.5" />
          </UiButton>
          {isAdmin && <UiButton action="upload" content="iconText" variant="plain" type="button" controlSize="compact" onClick={() => globalRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" />
          </UiButton>}
          {desktop && <UiButton action="upload" content="iconText" variant="plain" type="button" controlSize="compact" onClick={() => personalRef.current?.click()}>
            <Laptop className="h-3.5 w-3.5" />
          </UiButton>}
          {/* design-system-native: file-input */}
          <input ref={globalRef} aria-label="Choose a global extension package" type="file" accept=".cheers-extension,application/vnd.cheers.extension+zip" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void prepareFile(file, "global"); event.target.value = ""; }} />
          {/* design-system-native: file-input */}
          <input ref={personalRef} aria-label="Choose a personal extension package" type="file" accept=".cheers-extension,application/vnd.cheers.extension+zip" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void prepareFile(file, "personal"); event.target.value = ""; }} />
        </div>}
      >
        {global.map((extension) => (
          <WorkbenchItem
            key={`global:${extension.id}`}
            title={`${extension.title} · ${extension.version}`}
            leading={<Package className="h-3.5 w-3.5 text-accent-300" />}
            status={<span className="text-minimal text-content-muted">{extension.origin === "system" ? "Official" : "Global"} · Installed · Ready · {extension.scenes.length} Scenes · {extension.automations.length} Automations</span>}
            actions={<UiButton action="uninstall" content="icon" variant="plain" aria-label={`Uninstall ${extension.title}`} title="Uninstall" onClick={async () => { await deleteExtension(extension.id); await reload(); }} className="text-content-primary hover:text-danger-400"><Trash2 className="h-3.5 w-3.5" /></UiButton>}
          />
        ))}
        {personal.map((extension) => {
          const permissions = permissionSummary(extension.manifest);
          const disabled = isPersonalExtensionDisabled(extension.manifest.id);
          const runtime = personalExtensionStatus(extension.manifest.id);
          const status = disabled ? "Disabled" : runtime.status === "failed" ? "Failed" : runtime.status === "running" ? "Running" : "Ready";
          return <WorkbenchItem
            key={`personal:${extension.manifest.id}`}
            title={`${extension.manifest.title} · ${extension.manifest.version}`}
            leading={<Laptop className="h-3.5 w-3.5 text-success-300" />}
            status={<span className={runtime.status === "failed" && !disabled ? "text-minimal text-danger-400" : "text-minimal text-content-muted"} title={runtime.error ?? (permissions.join(", ") || "No permissions")}>This Mac · Installed · {status} · {extension.scenes.length} Scenes · {extension.manifest.contributes.renderers?.length ?? 0} Renderer · {extension.manifest.contributes.automations?.length ?? 0} Automations · {permissions.length || "No"} Permissions</span>}
            actions={<div className="flex items-center gap-1">
              <UiButton action={disabled ? "enable" : "disable"} content="icon" variant="plain" aria-label={`${disabled ? "Enable" : "Disable"} ${extension.manifest.title}`} title={disabled ? "Enable" : "Disable"} onClick={() => setPersonalExtensionDisabled(extension.manifest.id, !disabled)} className="text-content-primary hover:text-content-strong">{disabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}</UiButton>
              <UiButton action="uninstall" content="icon" variant="plain" aria-label={`Uninstall ${extension.manifest.title}`} title="Uninstall from this Mac" onClick={async () => { setPersonalExtensionDisabled(extension.manifest.id, false); await removePersonalExtension(extension.manifest.id); await reload(); }} className="text-content-primary hover:text-danger-400"><Trash2 className="h-3.5 w-3.5" /></UiButton>
            </div>}
          />;
        })}
        {listTemporaryExtensions().map(({ extension, status, error: runtimeError }) => {
          const permissions = permissionSummary(extension.manifest);
          return <WorkbenchItem
            key={`temporary:${extension.manifest.id}`}
            title={`${extension.manifest.title} · ${extension.manifest.version}`}
            leading={<Upload className="h-3.5 w-3.5 text-warning-300" />}
            status={<span className={status === "failed" ? "text-minimal text-danger-400" : "text-minimal text-content-muted"} title={runtimeError ?? (permissions.join(", ") || "No permissions")}>Temporary · {status === "failed" ? "Failed" : status === "running" ? "Running" : "Ready"} · {extension.scenes.length} Scenes · {extension.manifest.contributes.renderers?.length ?? 0} Renderer · {permissions.length || "No"} Permissions</span>}
            actions={<UiButton action="remove" content="icon" variant="plain" aria-label={`Remove temporary ${extension.manifest.title}`} title="Remove temporary extension" onClick={() => removeTemporaryExtension(extension.manifest.id)} className="text-content-primary hover:text-danger-400"><X className="h-3.5 w-3.5" /></UiButton>}
          />;
        })}
        {global.length === 0 && personal.length === 0 && listTemporaryExtensions().length === 0 && <WorkbenchItem title="No extensions installed" />}
      </ItemSection>

      <ItemSection
        label="Official catalog"
        presentationLevel="medium"
        controlSize="regular"
        className="mt-6 border-t border-zinc-800 pt-2"
        description="Verified extensions from the official Cheers catalog."
      >
        {catalogEntries.map((entry) => {
          const isInstalledGlobal = global.find((e) => e.id === entry.id);
          const isInstalledPersonal = personal.find((e) => e.manifest.id === entry.id);
          const installedVer = isInstalledPersonal?.manifest.version ?? isInstalledGlobal?.version;
          const hasUpdate = Boolean(installedVer && compareSemver(entry.version, installedVer) > 0);
          const isInstalled = Boolean(isInstalledGlobal || isInstalledPersonal);
          const targetScope: InstallScope = desktop ? "personal" : "global";
          const canInstall = !isInstalled || hasUpdate;
          const isPermitted = desktop || (isAdmin && entry.globalCapable);

          return (
            <WorkbenchItem
              key={`catalog:${entry.id}`}
              title={`${entry.title.en} · ${entry.version}`}
              leading={<Package className="h-3.5 w-3.5 text-accent-300" />}
              status={
                <span className="text-minimal text-content-muted">
                  {entry.category} · {entry.contributes.scenes} Scenes · {entry.contributes.renderers} Renderers
                  {isInstalled
                    ? hasUpdate
                      ? ` · Installed (${installedVer}) — Update Available`
                      : ` · Installed (${installedVer})`
                    : " · Official"}
                </span>
              }
              actions={
                <div className="flex items-center gap-2">
                  {canInstall && isPermitted && (
                    <UiButton
                      action={hasUpdate ? "update" : "install"}
                      content="iconText"
                      variant="plain"
                      controlSize="compact"
                      onClick={() => void installFromCatalog(entry, targetScope)}
                    />
                  )}
                </div>
              }
            />
          );
        })}
        {catalogEntries.length === 0 && catalogLoadingState && (
          <WorkbenchItem title="Loading official catalog..." />
        )}
        {catalogEntries.length === 0 && !catalogLoadingState && !catalogError && (
          <WorkbenchItem title="No catalog extensions found" />
        )}
        {catalogError && (
          <WorkbenchItem
            title="Official catalog temporarily unavailable"
            status={<span className="text-minimal text-content-muted">{catalogError}</span>}
          />
        )}
      </ItemSection>

      {candidate && <ExtensionInstallDialog candidate={candidate} installed={installed} busy={installing} onConfirm={() => void confirmInstall()} onClose={() => { clearExtensionInstallIntent(); setCandidate(null); }} />}
    </section>
  );
}
