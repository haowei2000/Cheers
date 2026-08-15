import { Button as UiButton } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Blocks, CircleCheck, Laptop, Package, Puzzle, Trash2, Upload } from "lucide-react";
import { Banner } from "@/components/ui/banner";
import { ItemSection, WorkbenchItem } from "@/components/ui/item";
import { useIsAdmin } from "@/stores/authStore";
import { isTauri } from "@/lib/serverConfig";
import {
  installPersonalPlugin,
  listPersonalPlugins,
  removePersonalPlugin,
} from "@/lib/desktop";
import {
  installPlugin,
  listPlugins,
  deletePlugin,
  parsePluginHtml,
  MAX_PLUGIN_BUNDLE_BYTES,
  type PluginMeta,
} from "@/features/chat/workbench/sandbox/api";
import {
  listGlobalTemplates,
  saveGlobalTemplate,
  deleteGlobalTemplate,
} from "@/features/chat/workbench/templatesApi";
import { validateManifest, type TemplateManifest } from "@/features/chat/workbench/manifest";

// Admin surface for the two SERVER-LEVEL workbench extension kinds (see docs/arch/WORKBENCH.md):
//  - Plugins  — CODE, sandboxed .html bundle (renderers).
//  - Templates — DATA, declarative .json manifest (scenarios). Inert, no sandbox.
// Both are global: install once, every user sees them. Non-admins never see this section;
// they get ad-hoc/one-off templates via the workbench drawer's temporary upload instead.
/** A personal plugin as shown in this manager — id + title parsed from the
 *  on-disk bundle (the bundle itself stays on the Rust side). */
interface PersonalEntry {
  id: string;
  title: string;
}

export function WorkbenchManager() {
  const isAdmin = useIsAdmin();
  const desktop = isTauri();

  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [templates, setTemplates] = useState<TemplateManifest[]>([]);
  const [personal, setPersonal] = useState<PersonalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pluginRef = useRef<HTMLInputElement>(null);
  const tplRef = useRef<HTMLInputElement>(null);
  const personalRef = useRef<HTMLInputElement>(null);

  const reloadPersonal = useCallback(async () => {
    if (!desktop) return;
    const entries: PersonalEntry[] = [];
    for (const p of await listPersonalPlugins()) {
      try {
        const { id, title } = parsePluginHtml(p.content);
        entries.push({ id, title });
      } catch {
        // A bundle that no longer parses is simply not listed.
      }
    }
    setPersonal(entries);
  }, [desktop]);

  const reload = useCallback(async () => {
    try {
      if (isAdmin) {
        const [p, t] = await Promise.all([listPlugins(), listGlobalTemplates()]);
        setPlugins(p);
        setTemplates(t);
      }
      await reloadPersonal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [isAdmin, reloadPersonal]);

  useEffect(() => {
    if (isAdmin || desktop) void reload();
  }, [isAdmin, desktop, reload]);

  const onUploadPersonal = useCallback(
    async (html: string) => {
      setError(null);
      try {
        const { id, title } = parsePluginHtml(html);
        const bytes = new TextEncoder().encode(html).length;
        if (bytes > MAX_PLUGIN_BUNDLE_BYTES) {
          setError("Plugin bundle too large (max 2 MiB)");
          return;
        }
        if (
          !window.confirm(
            `Install "${title}" on this Mac?\n\n` +
              "This plugin's code runs in an isolated sandbox — it can't read your login " +
              "token or the rest of the app. But the sandbox does NOT block network access: " +
              "a plugin can send the file content it renders to the internet. Only install " +
              "renderers you trust."
          )
        )
          return;
        await installPersonalPlugin(id, html);
        setNotice(`Installed on this Mac: ${title}`);
        await reloadPersonal();
      } catch (e) {
        setError(`Plugin install failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [reloadPersonal]
  );

  const onUploadPlugin = useCallback(
    async (html: string) => {
      setError(null);
      try {
        const { id, title, manifest } = parsePluginHtml(html);
        await installPlugin({ id, title, manifest, bundle: html });
        setNotice(`Installed plugin: ${title}`);
        await reload();
      } catch (e) {
        setError(`Plugin install failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [reload]
  );

  const onUploadTemplate = useCallback(
    async (text: string) => {
      setError(null);
      let m: unknown;
      try {
        m = JSON.parse(text);
      } catch {
        setError("Not valid JSON");
        return;
      }
      if (!validateManifest(m)) {
        setError("Invalid template: missing id/title/views, or references an unknown lens");
        return;
      }
      try {
        await saveGlobalTemplate(m);
        setNotice(`Installed global template: ${m.title}`);
        await reload();
      } catch (e) {
        setError(`Template install failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [reload]
  );

  // Admins manage the global (server) extensions; desktop users additionally get
  // the personal (this-Mac) card. Nothing to show for a non-admin on the web.
  if (!isAdmin && !desktop) return null;

  return (
    <section>
      <h2 className="text-compact font-semibold text-content-muted uppercase tracking-section mb-4 flex items-center gap-2">
        <Blocks className="w-3.5 h-3.5" />
        Workbench extensions
      </h2>

      {(error || notice) && (
        <Banner
          severity={error ? "error" : "success"}
          icon={error ? AlertCircle : CircleCheck}
          className="mb-3"
          onDismiss={() => {
            setError(null);
            setNotice(null);
          }}
        >
          {error ?? notice}
        </Banner>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Plugins — CODE (sandboxed), admin/global */}
        {isAdmin && (
        <ItemSection
          label="Plugins · code / sandboxed"
          presentationLevel="medium"
          controlSize="regular"
          className="border-t border-zinc-800 pt-2"
          description="Sandboxed renderer bundles available in every channel."
          action={<><UiButton action="upload" content="iconText" variant="plain"
              type="button"
              onClick={() => pluginRef.current?.click()}
              controlSize="compact"
              className="text-warning-400 hover:text-warning-300"
            >
              <Upload className="w-3.5 h-3.5" /> Upload HTML
            </UiButton>
            {/* design-system-native: file-input */}
<input
              ref={pluginRef}
              type="file"
              accept=".html,text/html"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void f.text().then(onUploadPlugin);
                e.target.value = "";
              }}
            />
          </>}
        >
            {plugins.length === 0 && <WorkbenchItem title="No plugins yet" />}
            {plugins.map((p) => (
              <WorkbenchItem
                key={p.plugin_id}
                title={<span title={`${p.title} · ${p.plugin_id}`}>{p.title} · {p.plugin_id}</span>}
                leading={<Puzzle className="w-3.5 h-3.5 text-warning-400/70 flex-shrink-0" />}
                status={p.origin === "system" ? (
                  <span
                    title="Official plugin, seeded by the gateway release. Updates ship with releases; it can't be overwritten by upload (copy under a new id to customize). Deleting it sticks until a release carries a newer version."
                    className="text-minimal px-2 py-1 rounded-sm bg-indigo-500/15 text-accent-300 flex-shrink-0"
                  >
                    Official
                  </span>
                ) : undefined}
                actions={<UiButton action="uninstall" content="icon" aria-label={`Uninstall ${p.title}`} variant="plain"
                  onClick={async () => {
                    if (
                      p.origin === "system" &&
                      !window.confirm(
                        `Remove official plugin "${p.title}"? It stays removed across restarts and only returns when a gateway release ships a newer version of it.`
                      )
                    )
                      return;
                    await deletePlugin(p.plugin_id);
                    await reload();
                  }}
                  title="Uninstall"
                  className="text-content-primary hover:text-danger-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </UiButton>}
              />
            ))}
        </ItemSection>

        )}

        {/* Templates — DATA (inert), admin/global */}
        {isAdmin && (
        <ItemSection
          label="Global templates · data"
          presentationLevel="medium"
          controlSize="regular"
          className="border-t border-zinc-800 pt-2"
          description="Declarative scenario manifests available in every channel; no code execution."
          action={<><UiButton action="upload" content="iconText" variant="plain"
              type="button"
              onClick={() => tplRef.current?.click()}
              controlSize="compact"
              className="text-accent-400 hover:text-accent-300"
            >
              <Upload className="w-3.5 h-3.5" /> Upload JSON
            </UiButton>
            {/* design-system-native: file-input */}
<input
              ref={tplRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void f.text().then(onUploadTemplate);
                e.target.value = "";
              }}
            />
          </>}
        >
            {templates.length === 0 && (
              <WorkbenchItem title="No global templates yet" />
            )}
            {templates.map((t) => (
              <WorkbenchItem
                key={t.id}
                title={t.title}
                status={<span className="max-w-32 truncate font-code text-minimal text-content-muted" title={t.id}>{t.id}</span>}
                leading={<Package className="w-3.5 h-3.5 text-accent-400/70 flex-shrink-0" />}
                actions={<UiButton action="uninstall" content="icon" aria-label={`Uninstall ${t.title}`} variant="plain"
                  onClick={async () => {
                    await deleteGlobalTemplate(t.id);
                    await reload();
                  }}
                  title="Uninstall"
                  className="text-content-primary hover:text-danger-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </UiButton>}
              />
            ))}
        </ItemSection>
        )}

        {/* Personal plugins — CODE (sandboxed), THIS Mac only (desktop app) */}
        {desktop && (
          <ItemSection
            label="On this Mac · personal"
            presentationLevel="medium"
            controlSize="regular"
            className="border-t border-zinc-800 pt-2"
            description="Renderer plugins installed only for you on this machine."
            action={<><UiButton action="upload" content="iconText" variant="plain"
                type="button"
                onClick={() => personalRef.current?.click()}
                controlSize="compact"
                className="text-success-400 hover:text-success-300"
              >
                <Upload className="w-3.5 h-3.5" /> Install HTML
              </UiButton>
              {/* design-system-native: file-input */}
<input
                ref={personalRef}
                type="file"
                accept=".html,.htm,text/html"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void f.text().then(onUploadPersonal);
                  e.target.value = "";
                }}
              />
            </>}
          >
              {personal.length === 0 && (
                <WorkbenchItem title="Nothing installed on this Mac" />
              )}
              {personal.map((p) => (
                <WorkbenchItem
                  key={p.id}
                  title={p.title}
                  status={<span className="max-w-32 truncate font-code text-minimal text-content-muted" title={p.id}>{p.id}</span>}
                  leading={<Laptop className="w-3.5 h-3.5 text-success-400/70 flex-shrink-0" />}
                  actions={<UiButton action="uninstall" content="icon" aria-label={`Uninstall ${p.title}`} variant="plain"
                    onClick={async () => {
                      await removePersonalPlugin(p.id);
                      await reloadPersonal();
                    }}
                    title="Uninstall from this Mac"
                    className="text-content-primary hover:text-danger-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </UiButton>}
                />
              ))}
          </ItemSection>
        )}
      </div>
    </section>
  );
}
