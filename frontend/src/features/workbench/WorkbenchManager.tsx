import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Blocks, CircleCheck, Laptop, Package, Puzzle, Trash2, Upload } from "lucide-react";
import { Banner } from "@/components/ui/banner";
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
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
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
        <div className="bg-zinc-900 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Puzzle className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Plugins (code / sandboxed)</h3>
            <button
              type="button"
              onClick={() => pluginRef.current?.click()}
              className="ml-auto inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
            >
              <Upload className="w-3.5 h-3.5" /> Upload .html
            </button>
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
          </div>
          <p className="text-[11px] text-zinc-400">
            Sandboxed plugins that ship their own renderer, available in every channel. On
            install they run inside an isolated browser iframe.
          </p>
          <ul className="space-y-1">
            {plugins.length === 0 && <li className="text-xs text-zinc-400">No plugins yet.</li>}
            {plugins.map((p) => (
              <li
                key={p.plugin_id}
                className="flex items-center gap-2 rounded-lg bg-zinc-950/60 px-2.5 py-1.5"
              >
                <Puzzle className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
                <span className="text-xs text-zinc-200 truncate flex-1">{p.title}</span>
                {p.origin === "system" && (
                  <span
                    title="Official plugin, seeded by the gateway release. Updates ship with releases; it can't be overwritten by upload (copy under a new id to customize). Deleting it sticks until a release carries a newer version."
                    className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 flex-shrink-0"
                  >
                    Official
                  </span>
                )}
                <code className="text-[10px] text-zinc-400 truncate max-w-[80px]">{p.plugin_id}</code>
                <button
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
                  className="text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        )}

        {/* Templates — DATA (inert), admin/global */}
        {isAdmin && (
        <div className="bg-zinc-900 rounded-2xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-indigo-400" />
            <h3 className="text-sm font-semibold text-zinc-100">Global templates (data)</h3>
            <button
              type="button"
              onClick={() => tplRef.current?.click()}
              className="ml-auto inline-flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
            >
              <Upload className="w-3.5 h-3.5" /> Upload .json
            </button>
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
          </div>
          <p className="text-[11px] text-zinc-400">
            Declarative scenario manifests (referencing built-in lenses), available in every
            channel. Pure data — no code execution, no sandbox needed.
          </p>
          <ul className="space-y-1">
            {templates.length === 0 && (
              <li className="text-xs text-zinc-400">No global templates yet.</li>
            )}
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex items-center gap-2 rounded-lg bg-zinc-950/60 px-2.5 py-1.5"
              >
                <Package className="w-3.5 h-3.5 text-indigo-400/70 flex-shrink-0" />
                <span className="text-xs text-zinc-200 truncate flex-1">{t.title}</span>
                <code className="text-[10px] text-zinc-400 truncate max-w-[80px]">{t.id}</code>
                <button
                  onClick={async () => {
                    await deleteGlobalTemplate(t.id);
                    await reload();
                  }}
                  title="Uninstall"
                  className="text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
        )}

        {/* Personal plugins — CODE (sandboxed), THIS Mac only (desktop app) */}
        {desktop && (
          <div className="bg-zinc-900 rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Laptop className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-semibold text-zinc-100">On this Mac (personal)</h3>
              <button
                type="button"
                onClick={() => personalRef.current?.click()}
                className="ml-auto inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
              >
                <Upload className="w-3.5 h-3.5" /> Install .html
              </button>
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
            </div>
            <p className="text-[11px] text-zinc-400">
              Renderer plugins installed only for you, on this machine — no admin needed.
              Stored in <code className="text-zinc-300">~/.cheers/plugins</code>; other members
              won't see them (a file bound to one falls back to raw for them).
            </p>
            <ul className="space-y-1">
              {personal.length === 0 && (
                <li className="text-xs text-zinc-400">Nothing installed on this Mac.</li>
              )}
              {personal.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 rounded-lg bg-zinc-950/60 px-2.5 py-1.5"
                >
                  <Laptop className="w-3.5 h-3.5 text-emerald-400/70 flex-shrink-0" />
                  <span className="text-xs text-zinc-200 truncate flex-1">{p.title}</span>
                  <code className="text-[10px] text-zinc-400 truncate max-w-[80px]">{p.id}</code>
                  <button
                    onClick={async () => {
                      await removePersonalPlugin(p.id);
                      await reloadPersonal();
                    }}
                    title="Uninstall from this Mac"
                    className="text-zinc-500 hover:text-red-400"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
