import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Blocks, CircleCheck, Laptop, Package, Power, PowerOff, Trash2, Upload, X } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { Banner } from "@/components/ui/banner";
import { ItemSection, WorkbenchItem } from "@/components/ui/item";
import { useIsAdmin } from "@/stores/authStore";
import { isTauri } from "@/lib/serverConfig";
import {
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
  parseExtensionPackage,
  permissionSummary,
  type ParsedExtension,
} from "@/features/chat/workbench/extensions/package";
import {
  isPersonalExtensionDisabled,
  listTemporaryExtensions,
  personalExtensionStatus,
  removeTemporaryExtension,
  setPersonalExtensionDisabled,
  subscribeExtensionRuntime,
} from "@/features/chat/workbench/extensions/runtime";

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function WorkbenchManager() {
  const isAdmin = useIsAdmin();
  const desktop = isTauri();
  const [global, setGlobal] = useState<ExtensionSummary[]>([]);
  const [personal, setPersonal] = useState<ParsedExtension[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setRuntimeRevision] = useState(0);
  const globalRef = useRef<HTMLInputElement>(null);
  const personalRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setGlobal(await listExtensions());
      if (desktop) {
        const stored = await listPersonalExtensions();
        const parsed = await Promise.all(
          stored.map((entry) => parseExtensionPackage(fromBase64(entry.contentBase64), "personal"))
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

  useEffect(() => subscribeExtensionRuntime(() => setRuntimeRevision((value) => value + 1)), []);

  const installGlobal = useCallback(async (file: File) => {
    setError(null);
    try {
      const extension = await parseExtensionPackage(await file.arrayBuffer(), "global");
      await installGlobalExtension(extension.manifest, extension.bytes);
      setNotice(`Installed globally: ${extension.manifest.title}`);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [reload]);

  const installPersonal = useCallback(async (file: File) => {
    setError(null);
    try {
      const extension = await parseExtensionPackage(await file.arrayBuffer(), "personal");
      const permissions = permissionSummary(extension.manifest);
      const warning = [
        `Install "${extension.manifest.title}" on this Mac?`,
        `SHA-256: ${extension.sha256}`,
        permissions.length ? `Permissions:\n- ${permissions.join("\n- ")}` : "Permissions: none",
        extension.manifest.permissions?.network === "unrestricted"
          ? "This renderer may send rendered content to any network destination."
          : "Network access is blocked by the renderer CSP.",
      ].join("\n\n");
      if (!window.confirm(warning)) return;
      await installPersonalExtension(extension.manifest.id, extension.bytes, extension.sha256);
      setNotice(`Installed on this Mac: ${extension.manifest.title}`);
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [reload]);

  return (
    <section>
      <h2 className="mb-4 flex items-center gap-2 text-compact font-semibold uppercase tracking-wider text-zinc-400">
        <Blocks className="h-3.5 w-3.5" /> Workbench extensions
      </h2>
      {(error || notice) && (
        <Banner severity={error ? "error" : "success"} icon={error ? AlertCircle : CircleCheck} className="mb-3" onDismiss={() => { setError(null); setNotice(null); }}>
          {error ?? notice}
        </Banner>
      )}
      <ItemSection
        label="Extensions"
        presentationLevel="medium"
        controlSize="regular"
        className="border-t border-zinc-800 pt-2"
        description="Scenes and renderers are installed from one verified .cheers-extension package."
        action={<div className="flex items-center gap-2">
          {isAdmin && <UiButton action="upload" content="iconText" variant="plain" type="button" controlSize="compact" onClick={() => globalRef.current?.click()}>
            <Upload className="h-3.5 w-3.5" /> Install globally
          </UiButton>}
          {desktop && <UiButton action="upload" content="iconText" variant="plain" type="button" controlSize="compact" onClick={() => personalRef.current?.click()}>
            <Laptop className="h-3.5 w-3.5" /> Install on this Mac
          </UiButton>}
          <input ref={globalRef} type="file" accept=".cheers-extension,application/vnd.cheers.extension+zip" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void installGlobal(file); event.target.value = ""; }} />
          <input ref={personalRef} type="file" accept=".cheers-extension,application/vnd.cheers.extension+zip" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void installPersonal(file); event.target.value = ""; }} />
        </div>}
      >
        {global.map((extension) => (
          <WorkbenchItem
            key={`global:${extension.id}`}
            title={`${extension.title} · ${extension.version}`}
            leading={<Package className="h-3.5 w-3.5 text-indigo-300" />}
            status={<span className="text-minimal text-zinc-400">{extension.origin === "system" ? "Official" : "Global"} · Installed · Ready · {extension.scenes.length} Scenes · {extension.automations.length} Automations</span>}
            actions={<UiButton action="uninstall" content="icon" variant="plain" aria-label={`Uninstall ${extension.title}`} title="Uninstall" onClick={async () => { await deleteExtension(extension.id); await reload(); }} className="text-zinc-100 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></UiButton>}
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
            leading={<Laptop className="h-3.5 w-3.5 text-emerald-300" />}
            status={<span className={runtime.status === "failed" && !disabled ? "text-minimal text-red-400" : "text-minimal text-zinc-400"} title={runtime.error ?? (permissions.join(", ") || "No permissions")}>This Mac · Installed · {status} · {extension.scenes.length} Scenes · {extension.manifest.contributes.renderers?.length ?? 0} Renderer · {extension.manifest.contributes.automations?.length ?? 0} Automations · {permissions.length || "No"} Permissions</span>}
            actions={<div className="flex items-center gap-1">
              <UiButton action={disabled ? "enable" : "disable"} content="icon" variant="plain" aria-label={`${disabled ? "Enable" : "Disable"} ${extension.manifest.title}`} title={disabled ? "Enable" : "Disable"} onClick={() => setPersonalExtensionDisabled(extension.manifest.id, !disabled)} className="text-zinc-100 hover:text-zinc-50">{disabled ? <Power className="h-3.5 w-3.5" /> : <PowerOff className="h-3.5 w-3.5" />}</UiButton>
              <UiButton action="uninstall" content="icon" variant="plain" aria-label={`Uninstall ${extension.manifest.title}`} title="Uninstall from this Mac" onClick={async () => { setPersonalExtensionDisabled(extension.manifest.id, false); await removePersonalExtension(extension.manifest.id); await reload(); }} className="text-zinc-100 hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></UiButton>
            </div>}
          />;
        })}
        {listTemporaryExtensions().map(({ extension, status, error: runtimeError }) => {
          const permissions = permissionSummary(extension.manifest);
          return <WorkbenchItem
            key={`temporary:${extension.manifest.id}`}
            title={`${extension.manifest.title} · ${extension.manifest.version}`}
            leading={<Upload className="h-3.5 w-3.5 text-amber-300" />}
            status={<span className={status === "failed" ? "text-minimal text-red-400" : "text-minimal text-zinc-400"} title={runtimeError ?? (permissions.join(", ") || "No permissions")}>Temporary · {status === "failed" ? "Failed" : status === "running" ? "Running" : "Ready"} · {extension.scenes.length} Scenes · {extension.manifest.contributes.renderers?.length ?? 0} Renderer · {permissions.length || "No"} Permissions</span>}
            actions={<UiButton action="remove" content="icon" variant="plain" aria-label={`Remove temporary ${extension.manifest.title}`} title="Remove temporary extension" onClick={() => removeTemporaryExtension(extension.manifest.id)} className="text-zinc-100 hover:text-red-400"><X className="h-3.5 w-3.5" /></UiButton>}
          />;
        })}
        {global.length === 0 && personal.length === 0 && listTemporaryExtensions().length === 0 && <WorkbenchItem title="No extensions installed" />}
      </ItemSection>
    </section>
  );
}
