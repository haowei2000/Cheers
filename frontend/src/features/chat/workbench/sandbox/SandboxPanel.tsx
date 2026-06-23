import { useEffect, useRef, useState } from "react";
import type { PanelContext, PanelDef } from "../panelRegistry";
import type { FsClient } from "../fsClient";
import { fetchBundle, type PluginMeta } from "./api";

// Proxy a plugin's fs request. Paths are namespaced under plugins/<id>/ so a plugin can
// only touch its OWN folder; server-side channel-role authz still applies on top.
async function proxyFs(
  fs: FsClient,
  pluginId: string,
  op: string,
  args: { path?: string; content?: string; ifVersion?: number; recursive?: boolean }
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ns = (p?: string) => `plugins/${pluginId}/${String(p ?? "").replace(/^\/+/, "")}`;
  try {
    if (op === "read") return { ok: true, data: await fs.read(ns(args.path)) };
    if (op === "write")
      return { ok: true, data: await fs.write(ns(args.path), String(args.content ?? ""), args.ifVersion) };
    if (op === "ls") return { ok: true, data: await fs.ls(ns(args.path)) };
    if (op === "rm") return { ok: true, data: await fs.rm(ns(args.path), args.recursive) };
    return { ok: false, error: `unknown op: ${op}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "error" };
  }
}

function SandboxPanel({ ctx, plugin, panelId }: { ctx: PanelContext; plugin: PluginMeta; panelId: string }) {
  const [bundle, setBundle] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let alive = true;
    setBundle(null);
    setErr(null);
    fetchBundle(plugin.plugin_id)
      .then((b) => alive && setBundle(b))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [plugin.plugin_id]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return; // only THIS iframe
      const m = e.data as {
        type?: string;
        reqId?: number;
        op?: string;
        args?: Record<string, unknown>;
      };
      if (!m || typeof m !== "object") return;
      if (m.type === "cheers:ready") {
        win.postMessage({ type: "cheers:init", channelId: ctx.channelId, panelId }, "*");
      } else if (m.type === "cheers:fs") {
        void proxyFs(ctx.fs, plugin.plugin_id, m.op ?? "", m.args ?? {}).then((res) =>
          win.postMessage({ type: "cheers:fs:result", reqId: m.reqId, ...res }, "*")
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [ctx, plugin.plugin_id, panelId]);

  if (err) return <div className="p-3 text-amber-500 text-xs">插件加载失败：{err}</div>;
  if (bundle === null) return <div className="p-3 text-zinc-500 text-xs">加载插件…</div>;
  return (
    <iframe
      ref={iframeRef}
      // allow-scripts WITHOUT allow-same-origin => opaque (null) origin: the plugin cannot
      // read the host's token / cookies / localStorage. It reaches the workspace only via
      // the postMessage fs proxy above (which the host authz-gates server-side).
      sandbox="allow-scripts"
      srcDoc={bundle}
      title={plugin.title}
      className="w-full h-full border-0 bg-white"
    />
  );
}

// A server plugin's manifest panels -> PanelDefs (each rendered in a sandboxed iframe).
export function pluginToPanels(plugin: PluginMeta): PanelDef[] {
  const panels = plugin.manifest.panels?.length ? plugin.manifest.panels : [{ id: "main", title: plugin.title }];
  return panels.map((p) => ({
    id: `${plugin.plugin_id}:${p.id}`,
    title: p.title,
    render: (ctx) => <SandboxPanel ctx={ctx} plugin={plugin} panelId={p.id} />,
  }));
}
