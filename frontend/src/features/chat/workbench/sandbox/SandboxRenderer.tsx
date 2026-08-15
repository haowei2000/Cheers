import { useEffect, useMemo, useRef, useState } from "react";
import { ResourceError } from "../../hooks/useChatRealtime";
import type { FsClient } from "../fsClient";
import { formatOf } from "../renderers/registry";
import type { PluginMeta } from "./pluginManifest";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export function summarize(message: Record<string, unknown>): string {
  const clip = (value: string) => value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return Object.entries(message).flatMap(([key, value]) => {
    if (key === "type" || value === undefined) return [];
    if (typeof value === "string") return [`${key}=${JSON.stringify(clip(value))}`];
    if (typeof value === "number" || typeof value === "boolean") return [`${key}=${value}`];
    try { return [`${key}=${clip(JSON.stringify(value) ?? String(value))}`]; }
    catch { return [`${key}=[unserializable]`]; }
  }).join(" ");
}

const escapeScript = (source: string) => source.replace(/<\/script/gi, "<\\/script");

export function rendererCsp(network: "unrestricted" | undefined, nonce: string): string {
  const remote = network === "unrestricted";
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    remote ? "connect-src http: https: ws: wss:" : "connect-src 'none'",
    remote ? "img-src http: https: data: blob:" : "img-src data: blob:",
    remote ? "media-src http: https: data: blob:" : "media-src data: blob:",
    "font-src data:",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "navigate-to 'none'",
  ].join("; ");
}

export function buildRendererDocument(plugin: PluginMeta, rendererId: string): string {
  const renderer = plugin.manifest.renderers?.find((candidate) => candidate.id === rendererId);
  if (!renderer) throw new Error(`Renderer not found: ${rendererId}`);
  if (!renderer.entry) throw new Error(`Renderer entry is missing: ${rendererId}`);
  const code = plugin.assets?.[renderer.entry];
  if (!code) throw new Error(`Renderer entry is missing: ${renderer.entry}`);
  const css = renderer.style ? plugin.assets?.[renderer.style] ?? "" : "";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const bridge = `
    (() => {
      let seq = 0;
      let disposer;
      let renderHandler;
      const pending = new Map();
      const send = (method, params) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject });
        parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      });
      const ctx = {
        file: {
          onRender(handler) { renderHandler = handler; },
          save(content) { return send("file.save", { content }); }
        },
        channel: { read(resource, params = {}) { return send("channel.read", { resource, params }); } },
        navigation: { open(uri) { return send("navigation.open", { uri }); } },
        composer: { prefill(text) { return send("composer.prefill", { text }); } },
        log(level, message) { parent.postMessage({ jsonrpc: "2.0", method: "log", params: { level, message } }, "*"); }
      };
      globalThis.__CHEERS_RENDERER_CONTEXT__ = ctx;
      addEventListener("message", async (event) => {
        if (event.source !== parent || !event.data || event.data.jsonrpc !== "2.0") return;
        const message = event.data;
        if (message.id != null && !message.method) {
          const callback = pending.get(message.id); if (!callback) return;
          pending.delete(message.id);
          message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
          return;
        }
        if (message.method === "file.render") {
          try { await renderHandler?.(message.params); parent.postMessage({ jsonrpc: "2.0", id: message.id, result: null }, "*"); }
          catch (error) { parent.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error) } }, "*"); }
        }
        if (message.method === "lifecycle.dispose") {
          try { await disposer?.(); parent.postMessage({ jsonrpc: "2.0", id: message.id, result: null }, "*"); }
          catch (error) { parent.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error) } }, "*"); }
        }
      });
      globalThis.__CHEERS_START_RENDERER__ = async () => {
        const renderer = globalThis.CheersWorkbenchRenderer;
        if (!renderer || typeof renderer.activate !== "function") throw new Error("Renderer must call defineRenderer()");
        disposer = await renderer.activate(ctx);
        parent.postMessage({ jsonrpc: "2.0", method: "renderer.ready" }, "*");
      };
      addEventListener("pagehide", () => { try { disposer?.(); } catch {} });
    })();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${rendererCsp(plugin.manifest.permissions?.network, nonce)}"><style nonce="${nonce}">html,body,#root{height:100%;margin:0}${css}</style></head><body><div id="root"></div><script nonce="${nonce}">${bridge}</script><script nonce="${nonce}">${escapeScript(code)}\n;globalThis.__CHEERS_START_RENDERER__().catch((error) => parent.postMessage({ jsonrpc: "2.0", method: "renderer.failed", params: { message: String(error) } }, "*"));</script></body></html>`;
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
  readChannel: (resource: string, params: Record<string, unknown>) => Promise<unknown>;
  onOpen?: (uri: string) => void;
  onCompose?: (text: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const versionRef = useRef(0);
  const requestRef = useRef(0);
  const [status, setStatus] = useState<"ready" | "running" | "failed">("ready");
  const [error, setError] = useState("");
  const document = useMemo(() => buildRendererDocument(plugin, rendererId), [plugin, rendererId]);

  useEffect(() => {
    const respond = (message: RpcRequest, result?: unknown, errorMessage?: string) => {
      if (message.id == null) return;
      const response: RpcResponse = errorMessage
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: errorMessage } }
        : { jsonrpc: "2.0", id: message.id, result };
      iframeRef.current?.contentWindow?.postMessage(response, "*");
    };
    const sendRender = async () => {
      let content = "";
      let version = 0;
      try {
        const file = await fs.read(path);
        content = file.content;
        version = file.version;
      } catch (reason) {
        if (!(reason instanceof ResourceError && reason.code === "NOT_FOUND")) throw reason;
      }
      versionRef.current = version;
      iframeRef.current?.contentWindow?.postMessage(
        { jsonrpc: "2.0", id: ++requestRef.current, method: "file.render", params: { path, format: formatOf(path), content, version, rendererId } },
        "*"
      );
      setStatus("running");
    };
    const handler = (event: MessageEvent<RpcRequest>) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const message = event.data;
      const params = message.params ?? {};
      if (message.method === "renderer.ready") void sendRender().catch((reason) => { setError(String(reason)); setStatus("failed"); });
      else if (message.method === "file.save") {
        if (!plugin.manifest.permissions?.fileWrite) return respond(message, undefined, "file.write permission denied");
        fs.write(path, String(params.content ?? ""), versionRef.current)
          .then((result) => { versionRef.current = result.version; respond(message, result); })
          .catch((reason) => respond(message, undefined, reason instanceof Error ? reason.message : String(reason)));
      } else if (message.method === "channel.read") {
        const resource = String(params.resource ?? "");
        if (!plugin.manifest.permissions?.channelResources?.includes(resource)) return respond(message, undefined, "channel resource permission denied");
        readChannel(resource, (params.params as Record<string, unknown>) ?? {}).then((result) => respond(message, result)).catch((reason) => respond(message, undefined, String(reason)));
      } else if (message.method === "navigation.open") {
        if (!plugin.manifest.permissions?.navigationOpen) return respond(message, undefined, "navigation.open permission denied");
        onOpen?.(String(params.uri ?? "")); respond(message, null);
      } else if (message.method === "composer.prefill") {
        if (!plugin.manifest.permissions?.composerPrefill) return respond(message, undefined, "composer.prefill permission denied");
        onCompose?.(String(params.text ?? "").slice(0, 4000)); respond(message, null);
      } else if (message.method === "renderer.unsupported") {
        setError(String(params.reason ?? "Unsupported content")); setStatus("failed"); respond(message, null);
      } else if (message.method === "renderer.failed") {
        setError(String(params.message ?? "Activation failed")); setStatus("failed");
      }
    };
    window.addEventListener("message", handler);
    return () => {
      iframeRef.current?.contentWindow?.postMessage({ jsonrpc: "2.0", id: ++requestRef.current, method: "lifecycle.dispose" }, "*");
      window.removeEventListener("message", handler);
    };
  }, [fs, path, rendererId, plugin, readChannel, onOpen, onCompose]);

  if (status === "failed") return <div className="p-3 text-amber-400 text-compact">Renderer failed: {error}. Showing Raw is still available.</div>;
  return <iframe ref={iframeRef} sandbox="allow-scripts" srcDoc={document} title={`${plugin.title} (${status})`} className="h-full w-full border-0 bg-white" />;
}
