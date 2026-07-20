import { useCallback, useEffect, useRef, useState } from "react";
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

/** One line in the dev protocol inspector (session-loaded plugins only). */
interface DevEvent {
  seq: number;
  dir: "in" | "out";
  type: string;
  detail: string;
  at: number;
}

/** Keep the inspector bounded — a chatty plugin must not grow the tab's heap. */
const DEV_MAX_EVENTS = 200;

/** One-line, non-throwing summary of a protocol message for the inspector. Content and
 *  resource payloads are truncated: this is a traffic log, not a data viewer. Exported
 *  for tests — it must never throw on plugin-controlled input (cyclic objects included),
 *  or a malformed message would take the panel down instead of being logged. */
export function summarize(m: Record<string, unknown>): string {
  const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === "type") continue;
    if (v === undefined) continue;
    if (typeof v === "string") parts.push(`${k}=${JSON.stringify(clip(v))}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
    else {
      let s: string;
      try {
        s = JSON.stringify(v) ?? String(v);
      } catch {
        s = "[unserializable]";
      }
      parts.push(`${k}=${clip(s)}`);
    }
  }
  return parts.join(" ");
}

export function SandboxRenderer({
  fs,
  plugin,
  rendererId,
  path,
  readChannel,
  onOpen,
  onCompose,
}: {
  fs: FsClient;
  plugin: PluginMeta;
  rendererId: string;
  path: string;
  // host API: a whitelisted, channel-scoped reader for channel.* verbs (info/members/…)
  readChannel: (resource: string, params: Record<string, unknown>) => Promise<unknown>;
  /** host API: navigate the USER's view to a `cheers:` locator (cheers:open). Pure UI
   *  routing — the host parses/validates the locator and every read behind the jump
   *  still passes the existing authz; the plugin gains no data access from this. */
  onOpen?: (uri: string) => void;
  /** host API: PREFILL the channel composer (cheers:compose). Never sends — the human
   *  reviews and presses send, which is what turns the suggestion into an action. */
  onCompose?: (text: string) => void;
}) {
  const [bundle, setBundle] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const versionRef = useRef<number>(0); // last-known version for optimistic writes

  // Dev protocol inspector — ON for session-loaded plugins only (the ⏱ dev loop). The
  // sandbox has an opaque origin, so a plugin's uncaught errors and console output never
  // reach the host: this log (plus the SDK's cheers:log forwarding) is the only way an
  // author can see what their renderer actually exchanged with the host. Installed
  // plugins stay silent — this is a development affordance, not telemetry.
  const dev = plugin.transient === true;
  const [devEvents, setDevEvents] = useState<DevEvent[]>([]);
  const [devOpen, setDevOpen] = useState(false);
  const devSeq = useRef(0);
  const pushDev = useCallback((dir: "in" | "out", type: string, detail: string) => {
    setDevEvents((prev) => {
      const next = prev.concat({ seq: ++devSeq.current, dir, type, detail, at: Date.now() });
      return next.length > DEV_MAX_EVENTS ? next.slice(next.length - DEV_MAX_EVENTS) : next;
    });
  }, []);

  useEffect(() => {
    let alive = true;
    setBundle(null);
    setErr(null);
    // A changed bundle means a hot reload (or a different plugin): the iframe reboots,
    // so start the inspector log fresh rather than interleaving two runs.
    setDevEvents([]);
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
    // Every host → plugin message goes through here so the inspector sees the same
    // traffic the plugin does.
    const post = (win: Window, msg: Record<string, unknown>) => {
      if (dev) pushDev("out", String(msg.type ?? "?"), summarize(msg));
      win.postMessage(msg, "*");
    };

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
      post(win, { type: "cheers:render", path, format: formatOf(path), content, version, rendererId });
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
        uri?: string;
        text?: string;
        level?: string;
        message?: string;
      };
      if (!m || typeof m !== "object") return;
      if (dev) pushDev("in", String(m.type ?? "?"), summarize(m as Record<string, unknown>));
      if (m.type === "cheers:log") {
        // Dev-loop diagnostics: the SDK forwards console output and uncaught errors here
        // because an opaque-origin sandbox can't surface them any other way. Host-side
        // this is inert — shape-gated, capped, and only ever rendered as text in the
        // inspector. Unknown to older hosts, which ignore it (protocol 1 growth rule).
        return;
      }
      if (m.type === "cheers:ready") {
        setUnsupported(null);
        void sendRender(win);
      } else if (m.type === "cheers:resource") {
        // host API: whitelisted channel.* read, scoped to THIS channel (forced by readChannel)
        readChannel(m.resource ?? "", m.params ?? {})
          .then((data) => post(win, { type: "cheers:resource:result", reqId: m.reqId, ok: true, data }))
          .catch((rerr) =>
            post(win, {
              type: "cheers:resource:result",
              reqId: m.reqId,
              ok: false,
              error: rerr instanceof Error ? rerr.message : "error",
            })
          );
      } else if (m.type === "cheers:open") {
        // host API: navigate the user's view to a cheers: locator. Shape-gated here
        // (string, scheme prefix, sane length); the handler parses strictly and shows
        // a clear error for anything unresolvable. No-op when the host didn't wire a
        // handler — pre-existing plugins may send this before every surface supports it.
        const uri = typeof m.uri === "string" ? m.uri.trim() : "";
        if (onOpen && uri.startsWith("cheers:") && uri.length <= 2048) onOpen(uri);
      } else if (m.type === "cheers:compose") {
        // host API: PREFILL the channel composer — never send. Shape-gated (string,
        // control chars stripped, length cap); the human reviews and presses send.
        const text =
          typeof m.text === "string"
            ? // eslint-disable-next-line no-control-regex
              m.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim()
            : "";
        if (onCompose && text && text.length <= 4000) onCompose(text);
      } else if (m.type === "cheers:unsupported") {
        // the renderer inspected the content and can't render it (its final judgment)
        setUnsupported(typeof m.reason === "string" ? m.reason : "");
      } else if (m.type === "cheers:save") {
        // Always write the ASSIGNED path — the plugin cannot choose another file.
        fs.write(path, String(m.content ?? ""), versionRef.current)
          .then((r) => {
            versionRef.current = r.version;
            post(win, { type: "cheers:saved", ok: true, version: r.version });
          })
          .catch((werr) => {
            post(win, { type: "cheers:saved", ok: false, error: werr instanceof Error ? werr.message : "error" });
            // On a version conflict, re-render the latest so the plugin re-syncs.
            if (werr instanceof ResourceError && werr.code === "VERSION_CONFLICT") void sendRender(win);
          });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [fs, plugin.plugin_id, rendererId, path, readChannel, onOpen, onCompose, dev, pushDev]);

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
      {dev && (
        <>
          <button
            type="button"
            onClick={() => setDevOpen((v) => !v)}
            title="Protocol inspector (session-loaded plugins only)"
            className="absolute bottom-2 right-2 z-10 rounded bg-zinc-900/90 px-2 py-1 text-[11px] text-zinc-300 ring-1 ring-zinc-700 hover:text-white"
          >
            {devOpen ? "Hide" : "Dev"} · {devEvents.length}
          </button>
          {devOpen && (
            <div className="absolute inset-x-0 bottom-0 z-10 flex h-1/2 flex-col border-t border-zinc-700 bg-zinc-950/95">
              <div className="flex items-center justify-between px-2 py-1 text-[11px] text-zinc-400">
                <span>Protocol inspector · {plugin.plugin_id}</span>
                <button type="button" onClick={() => setDevEvents([])} className="hover:text-white">
                  Clear
                </button>
              </div>
              <div className="flex-1 overflow-auto px-2 pb-2 font-mono text-[11px] leading-relaxed">
                {devEvents.length === 0 ? (
                  <div className="text-zinc-500">
                    No messages yet. The plugin posts cheers:ready when it boots.
                  </div>
                ) : (
                  devEvents.map((ev) => (
                    <div key={ev.seq} className="flex gap-2 whitespace-pre-wrap break-all">
                      <span className={ev.dir === "in" ? "text-emerald-400" : "text-sky-400"}>
                        {ev.dir === "in" ? "←" : "→"}
                      </span>
                      <span className="text-zinc-200">{ev.type}</span>
                      <span className="text-zinc-500">{ev.detail}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
