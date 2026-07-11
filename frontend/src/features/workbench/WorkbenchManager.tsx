import { useCallback, useEffect, useRef, useState } from "react";
import { Blocks, Package, Puzzle, Trash2, Upload, X } from "lucide-react";
import { useIsAdmin } from "@/stores/authStore";
import {
  installPlugin,
  listPlugins,
  deletePlugin,
  parsePluginHtml,
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
export function WorkbenchManager() {
  const isAdmin = useIsAdmin();

  const [plugins, setPlugins] = useState<PluginMeta[]>([]);
  const [templates, setTemplates] = useState<TemplateManifest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pluginRef = useRef<HTMLInputElement>(null);
  const tplRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([listPlugins(), listGlobalTemplates()]);
      setPlugins(p);
      setTemplates(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void reload();
  }, [isAdmin, reload]);

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

  if (!isAdmin) return null;

  return (
    <section>
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-4 flex items-center gap-2">
        <Blocks className="w-3.5 h-3.5" />
        Workbench extensions
      </h2>

      {(error || notice) && (
        <div
          className={`mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
            error ? "bg-red-500/10 text-red-400" : "bg-emerald-500/10 text-emerald-400"
          }`}
        >
          <span className="flex-1">{error ?? notice}</span>
          <button
            onClick={() => {
              setError(null);
              setNotice(null);
            }}
            className="text-zinc-500 hover:text-zinc-300"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Plugins — CODE (sandboxed) */}
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
                <code className="text-[10px] text-zinc-400 truncate max-w-[80px]">{p.plugin_id}</code>
                <button
                  onClick={async () => {
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

        {/* Templates — DATA (inert) */}
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
      </div>
    </section>
  );
}
