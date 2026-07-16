import { useEffect, useRef, useState } from "react";
import { ResourceError } from "../../hooks/useChatRealtime";
import type { FsClient } from "../fsClient";
import { fetchBundle, type PluginMeta } from "./api";
import { formatOf } from "../renderers/registry";

// Render-mode sandbox host — the RENDERER_PLUGIN.md `render/save` protocol.
// Unlike the legacy panels SandboxPanel (which gave a plugin its own plugins/<id>/
// folder), this hands the plugin exactly ONE file (path + content) and lets it save
// THAT file back — the tightest capability: it can't touch any other path or channel.
//
//   host → plugin : cheers:render { path, format, content, version, rendererId }
//   plugin → host : cheers:ready                 (loaded — send me the file)
//   plugin → host : cheers:save   { content }    (write this one file back)
//   host → plugin : cheers:saved  { ok, version, error? }
export function SandboxRenderer({
  fs,
  plugin,
  rendererId,
  path,
  readChannel,
}: {
  fs: FsClient;
  plugin: PluginMeta;
  rendererId: string;
  path: string;
  // host API: a whitelisted, channel-scoped reader for channel.* verbs (info/members/…)
  readChannel: (resource: string, params: Record<string, unknown>) => Promise<unknown>;
}) {
  const [bundle, setBundle] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const versionRef = useRef<number>(0); // last-known version for optimistic writes

  useEffect(() => {
    let alive = true;
    setBundle(null);
    setErr(null);
    // Session-loaded (transient) plugins carry their bundle inline — no server fetch.
    if (plugin.bundle != null) {
      setBundle(plugin.bundle);
      return;
    }
    fetchBundle(plugin.plugin_id)
      .then((b) => alive && setBundle(b))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [plugin.plugin_id, plugin.bundle]);

  useEffect(() => {
    // Read the assigned file and tell the plugin to render it. A missing file renders
    // empty (version 0); the plugin's first save then creates it (if_version=0).
    async function sendRender(win: Window) {
      let content = "";
      let version = 0;
      try {
        const f = await fs.read(path);
        content = f.content;
        version = f.version;
      } catch (e) {
        if (!(e instanceof ResourceError && e.code === "NOT_FOUND")) throw e;
      }
      versionRef.current = version;
      win.postMessage(
        { type: "cheers:render", path, format: formatOf(path), content, version, rendererId },
        "*"
      );
    }

    const handler = (e: MessageEvent) => {
      const win = iframeRef.current?.contentWindow;
      if (!win || e.source !== win) return; // only THIS iframe
      const m = e.data as {
        type?: string;
        content?: string;
        reason?: string;
        reqId?: number;
        resource?: string;
        params?: Record<string, unknown>;
      };
      if (!m || typeof m !== "object") return;
      if (m.type === "cheers:ready") {
        setUnsupported(null);
        void sendRender(win);
      } else if (m.type === "cheers:resource") {
        // host API: whitelisted channel.* read, scoped to THIS channel (forced by readChannel)
        readChannel(m.resource ?? "", m.params ?? {})
          .then((data) => win.postMessage({ type: "cheers:resource:result", reqId: m.reqId, ok: true, data }, "*"))
          .catch((rerr) =>
            win.postMessage(
              { type: "cheers:resource:result", reqId: m.reqId, ok: false, error: rerr instanceof Error ? rerr.message : "error" },
              "*"
            )
          );
      } else if (m.type === "cheers:unsupported") {
        // the renderer inspected the content and can't render it (its final judgment)
        setUnsupported(typeof m.reason === "string" ? m.reason : "");
      } else if (m.type === "cheers:save") {
        // Always write the ASSIGNED path — the plugin cannot choose another file.
        fs.write(path, String(m.content ?? ""), versionRef.current)
          .then((r) => {
            versionRef.current = r.version;
            win.postMessage({ type: "cheers:saved", ok: true, version: r.version }, "*");
          })
          .catch((werr) => {
            win.postMessage(
              { type: "cheers:saved", ok: false, error: werr instanceof Error ? werr.message : "error" },
              "*"
            );
            // On a version conflict, re-render the latest so the plugin re-syncs.
            if (werr instanceof ResourceError && werr.code === "VERSION_CONFLICT") void sendRender(win);
          });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [fs, plugin.plugin_id, rendererId, path, readChannel]);

  if (err) return <div className="p-3 text-amber-400 text-xs">Failed to load renderer: {err}</div>;
  if (bundle === null) return <div className="p-3 text-zinc-400 text-xs">Loading renderer…</div>;
  return (
    <div className="relative w-full h-full">
      <iframe
        ref={iframeRef}
        // allow-scripts WITHOUT allow-same-origin => opaque (null) origin: the plugin
        // cannot read the host's token / cookies / localStorage.
        sandbox="allow-scripts"
        srcDoc={bundle}
        title={plugin.title}
        className="w-full h-full border-0 bg-white"
        style={unsupported !== null ? { display: "none" } : undefined}
      />
      {unsupported !== null && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-amber-400 bg-zinc-950">
          This renderer can't render this file{unsupported ? `: ${unsupported}` : ""}. Pick another
          renderer from the top-right dropdown, or choose "Raw".
        </div>
      )}
    </div>
  );
}
