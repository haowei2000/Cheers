import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { pointRect, useContextActions } from "@/components/ui/context-actions";
import { AddContextIcon, AnnotationIcon } from "@/components/ui/editorial-icons";
import { rangedFileContextItem, useContextPickStore } from "@/features/chat/context/contextPick";
import { ResourceError } from "../../hooks/useChatRealtime";
import type { FsClient } from "../fsClient";
import { formatOf } from "../renderers/registry";
import type { RendererExtension } from "./rendererExtension";
import { reportRendererStatus } from "../extensions/runtime";
import { uniqueSourceTextRange } from "../contextSource";
import type { LensContextTarget } from "../lens/registry";
import {
  createScheduledMessage,
  deleteScheduledMessage,
  listScheduledMessages,
  runScheduledMessageNow,
  updateScheduledMessage,
  type ScheduledMessageInput,
} from "@/api/scheduledMessages";

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

export function buildRendererDocument(extension: RendererExtension, rendererId: string): string {
  const renderer = extension.manifest.renderers?.find((candidate) => candidate.id === rendererId);
  if (!renderer) throw new Error(`Renderer not found: ${rendererId}`);
  if (!renderer.entry) throw new Error(`Renderer entry is missing: ${rendererId}`);
  const code = extension.assets?.[renderer.entry];
  if (!code) throw new Error(`Renderer entry is missing: ${renderer.entry}`);
  const css = renderer.style ? extension.assets?.[renderer.style] ?? "" : "";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const bridge = `
    (() => {
      let seq = 0;
      let disposer;
      let renderHandler;
      let contextAddedHandler;
      let inspectorEnabled = false;
      let overlay = null;
      let badge = null;
      const pending = new Map();
      const send = (method, params) => new Promise((resolve, reject) => {
        const id = ++seq; pending.set(id, { resolve, reject });
        parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      });
      const ensureOverlay = () => {
        if (!overlay) {
          overlay = document.createElement("div");
          overlay.className = "cheers-inspector-overlay";
          badge = document.createElement("div");
          badge.className = "cheers-inspector-badge";
          overlay.appendChild(badge);
          document.body.appendChild(overlay);
        }
        return overlay;
      };
      const getDomPath = (el) => {
        if (!el || el.nodeType !== 1) return "";
        const parts = [];
        let curr = el;
        while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement) {
          let seg = curr.tagName.toLowerCase();
          if (curr.id) {
            seg += "#" + curr.id;
            parts.unshift(seg);
            break;
          }
          if (curr.classList && curr.classList.length > 0) {
            const firstClass = curr.classList[0];
            if (firstClass && !firstClass.startsWith("cheers-")) {
              seg += "." + firstClass;
            }
          }
          let sibling = curr;
          let nth = 1;
          while ((sibling = sibling.previousElementSibling)) {
            if (sibling.tagName === curr.tagName) nth++;
          }
          if (nth > 1) seg += ":nth-of-type(" + nth + ")";
          parts.unshift(seg);
          curr = curr.parentElement;
        }
        return parts.join(" > ");
      };
      const onInspectorPointerMove = (e) => {
        if (!inspectorEnabled) return;
        const target = e.target;
        if (!target || target === overlay || overlay?.contains(target)) return;
        const r = target.getBoundingClientRect();
        if (!r.width && !r.height) return;
        const ov = ensureOverlay();
        ov.style.display = "block";
        ov.style.left = r.left + "px";
        ov.style.top = r.top + "px";
        ov.style.width = r.width + "px";
        ov.style.height = r.height + "px";
        const tag = target.tagName.toLowerCase();
        const cls = target.className && typeof target.className === "string" ? "." + target.className.trim().split(/\\s+/)[0] : "";
        badge.textContent = "<" + tag + (cls ? cls.slice(0, 16) : "") + ">";
        if (r.top < 24) {
          badge.style.top = "0px";
        } else {
          badge.style.top = "-22px";
        }
      };
      const onInspectorClick = (e) => {
        if (!inspectorEnabled) return;
        const target = e.target;
        if (!target || target === overlay || overlay?.contains(target)) return;
        e.preventDefault();
        e.stopPropagation();
        const r = target.getBoundingClientRect();
        const label = target.getAttribute("aria-label") || target.innerText?.trim().slice(0, 32) || target.tagName.toLowerCase();
        const domPath = getDomPath(target);
        const sourceText = (target.outerHTML || "").slice(0, 500);
        parent.postMessage({
          jsonrpc: "2.0",
          method: "inspector.inspect",
          params: {
            x: Math.round(r.left),
            y: Math.round(r.bottom),
            label,
            domPath,
            sourceText
          }
        }, "*");
      };
      const setInspector = (enabled) => {
        inspectorEnabled = Boolean(enabled);
        if (inspectorEnabled) {
          document.addEventListener("pointermove", onInspectorPointerMove, true);
          document.addEventListener("click", onInspectorClick, true);
        } else {
          document.removeEventListener("pointermove", onInspectorPointerMove, true);
          document.removeEventListener("click", onInspectorClick, true);
          if (overlay) overlay.style.display = "none";
        }
      };
      const ctx = {
        file: {
          onRender(handler) { renderHandler = handler; },
          save(content) { return send("file.save", { content }); }
        },
        channel: { read(resource, params = {}) { return send("channel.read", { resource, params }); } },
        navigation: { open(uri) { return send("navigation.open", { uri }); } },
        composer: { prefill(text) { return send("composer.prefill", { text }); } },
        form: {
          submit(formData, actionId = "submit") { return send("form.submit", { actionId, formData }); }
        },
        action: {
          trigger(actionId, payload = {}) { return send("action.trigger", { actionId, payload }); }
        },
        context: {
          pick(event, target) {
            event.preventDefault?.();
            const renderer = globalThis.CheersWorkbenchRenderer;
            Promise.resolve(renderer.toContext(target)).then((mapped) => {
              parent.postMessage({ jsonrpc: "2.0", method: "context.pick", params: {
                requestId: ++seq,
                x: Number(event.clientX) || 0,
                y: Number(event.clientY) || 0,
                label: mapped.label,
                sourceText: mapped.sourceText
              } }, "*");
            }).catch((error) => ctx.log("error", String(error)));
          },
          onAdded(handler) { contextAddedHandler = handler; }
        },
        automation: {
          list() { return send("automation.list", {}); },
          create(automationId, input) { return send("automation.create", { automationId, input }); },
          update(taskId, input) { return send("automation.update", { taskId, input }); },
          delete(taskId) { return send("automation.delete", { taskId }); },
          run(taskId) { return send("automation.run", { taskId }); }
        },
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
        if (message.method === "inspector.toggle") {
          setInspector(message.params?.enabled);
          if (message.id != null) parent.postMessage({ jsonrpc: "2.0", id: message.id, result: { enabled: inspectorEnabled } }, "*");
        }
        if (message.method === "file.render") {
          try { await renderHandler?.(message.params); parent.postMessage({ jsonrpc: "2.0", id: message.id, result: null }, "*"); }
          catch (error) { parent.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error) } }, "*"); }
        }
        if (message.method === "lifecycle.dispose") {
          setInspector(false);
          try { await disposer?.(); parent.postMessage({ jsonrpc: "2.0", id: message.id, result: null }, "*"); }
          catch (error) { parent.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error) } }, "*"); }
        }
        if (message.method === "context.added") contextAddedHandler?.(message.params);
      });
      globalThis.__CHEERS_START_RENDERER__ = async () => {
        const renderer = globalThis.CheersWorkbenchRenderer;
        if (!renderer || typeof renderer.activate !== "function") throw new Error("Renderer must call defineRenderer()");
        if (typeof renderer.toContext !== "function") throw new Error("Renderer must implement toContext(target)");
        disposer = await renderer.activate(ctx);
        parent.postMessage({ jsonrpc: "2.0", method: "renderer.ready" }, "*");
      };
      addEventListener("pagehide", () => {
        setInspector(false);
        try { disposer?.(); } catch {}
      });
  const inspectorCss = ".cheers-inspector-overlay{position:fixed;pointer-events:none;border:2px dashed #2563eb;background-color:rgba(37,99,235,0.12);z-index:2147483640;box-sizing:border-box;display:none;}\n.cheers-inspector-badge{position:absolute;left:0;top:-22px;background-color:#1d4ed8;color:#ffffff;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;line-height:14px;padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,0.3);}";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${rendererCsp(extension.manifest.permissions?.network, nonce)}"><style nonce="${nonce}">html,body,#root{height:100%;margin:0;}\n${css ? `${css}\n` : ""}${inspectorCss}</style></head><body><div id="root"></div><script nonce="${nonce}">${bridge}</script><script nonce="${nonce}">${escapeScript(code)}\n;globalThis.__CHEERS_START_RENDERER__().catch((error) => parent.postMessage({ jsonrpc: "2.0", method: "renderer.failed", params: { message: String(error) } }, "*"));</script></body></html>`;
}

export function SandboxRenderer({
  fs,
  extension,
  rendererId,
  path,
  readChannel,
  channelId,
  onOpen,
  onCompose,
  onFailure,
  onAnnotate,
  onFormSubmit,
  inspectorActive = false,
  active = true,
}: {
  fs: FsClient;
  extension: RendererExtension;
  rendererId: string;
  path: string;
  readChannel: (resource: string, params: Record<string, unknown>) => Promise<unknown>;
  channelId: string;
  onOpen?: (uri: string) => void;
  onCompose?: (text: string) => void;
  onFailure?: (reason: string) => void;
  onAnnotate?: (target: LensContextTarget, at: { x: number; y: number }) => void;
  onFormSubmit?: (data: { actionId: string; formData: Record<string, unknown> }) => void;
  inspectorActive?: boolean;
  active?: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const versionRef = useRef(0);
  const contentRef = useRef("");
  const requestRef = useRef(0);
  const failedRef = useRef(false);
  const pendingRef = useRef(new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>());
  const callbacksRef = useRef({ readChannel, onOpen, onCompose, onFailure, onAnnotate, onFormSubmit });
  callbacksRef.current = { readChannel, onOpen, onCompose, onFailure, onAnnotate, onFormSubmit };
  const [status, setStatus] = useState<"ready" | "running" | "failed">("ready");
  const [error, setError] = useState("");
  const { open } = useContextActions();
  const addContext = useContextPickStore((state) => state.add);
  const document = useMemo(() => buildRendererDocument(extension, rendererId), [extension, rendererId]);

  useEffect(() => {
    if (status === "running") {
      iframeRef.current?.contentWindow?.postMessage({
        jsonrpc: "2.0",
        method: "inspector.toggle",
        params: { enabled: Boolean(inspectorActive) },
      }, "*");
    }
  }, [inspectorActive, status]);

  useLayoutEffect(() => {
    if (!active) {
      failedRef.current = false;
      setStatus("ready");
      setError("");
      reportRendererStatus(extension.extensionId, "ready");
      return;
    }
    let alive = true;
    let disposed = false;
    const pendingRequests = pendingRef.current;
    failedRef.current = false;
    const respond = (message: RpcRequest, result?: unknown, errorMessage?: string) => {
      if (message.id == null) return;
      const response: RpcResponse = errorMessage
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: errorMessage } }
        : { jsonrpc: "2.0", id: message.id, result };
      iframeRef.current?.contentWindow?.postMessage(response, "*");
    };
    const extensionTasks = async () =>
      (await listScheduledMessages()).filter((task) => task.sourceExtensionId === extension.extensionId);
    const automationInput = (value: unknown, automationId: string): ScheduledMessageInput => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("automation input must be an object");
      }
      return {
        ...(value as ScheduledMessageInput),
        sourceExtensionId: extension.extensionId,
        sourceAutomationId: automationId,
      };
    };
    const request = (method: string, params?: Record<string, unknown>, timeoutMs = 2_000) => {
      const id = ++requestRef.current;
      return new Promise<unknown>((resolve, reject) => {
        pendingRef.current.set(id, { resolve, reject });
        iframeRef.current?.contentWindow?.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        window.setTimeout(() => {
          if (!pendingRef.current.delete(id)) return;
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      });
    };
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      try { await request("lifecycle.dispose", undefined, 500); }
      catch { /* pagehide remains the synchronous last-resort cleanup path */ }
    };
    const fail = async (reason: string) => {
      if (failedRef.current) return;
      failedRef.current = true;
      await dispose();
      if (!alive) return;
      setError(reason);
      setStatus("failed");
      reportRendererStatus(extension.extensionId, "failed", reason);
      callbacksRef.current.onFailure?.(reason);
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
      contentRef.current = content;
      await request("file.render", { path, format: formatOf(path), content, version, rendererId });
      setStatus("running");
      reportRendererStatus(extension.extensionId, "running");
    };
    const handler = (event: MessageEvent<RpcRequest | RpcResponse>) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const message = event.data;
      if (message.id != null && !("method" in message)) {
        const pending = pendingRef.current.get(message.id);
        if (!pending) return;
        pendingRef.current.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (!("method" in message)) return;
      const params = message.params ?? {};
      if (message.method === "renderer.ready") void sendRender().catch((reason) => void fail(String(reason)));
      else if (message.method === "inspector.inspect") {
        const frame = iframeRef.current?.getBoundingClientRect();
        const x = (frame?.left ?? 0) + Number(params.x ?? 0);
        const y = (frame?.top ?? 0) + Number(params.y ?? 0);
        const label = String(params.label ?? "element").trim().slice(0, 160);
        const sourceText = String(params.sourceText ?? "");
        const domPath = String(params.domPath ?? "");
        const target: LensContextTarget = {
          label: `<${label}>`,
          sourceText: sourceText || undefined,
          sourcePath: domPath ? [domPath] : undefined,
        };
        open({
          anchor: pointRect(x, y),
          source: "pointer",
          restoreFocus: iframeRef.current,
          actions: [
            {
              id: "annotate-inspect",
              label: `Annotate <${label}>`,
              icon: <AnnotationIcon className="h-4 w-4" />,
              run: () => {
                callbacksRef.current.onAnnotate?.(target, { x, y });
              },
            },
            {
              id: "ask-agent-inspect",
              label: `Ask agent about <${label}>`,
              icon: <AddContextIcon className="h-4 w-4" />,
              run: () => {
                const range = uniqueSourceTextRange(contentRef.current, sourceText);
                const item = range
                  ? rangedFileContextItem(path, range.start, range.end)
                  : rangedFileContextItem(path, 1, 1);
                addContext(channelId, { ...item, label: `<${label}>` });
                callbacksRef.current.onCompose?.(`Regarding <${label}> (${domPath}): `);
                toast.success(`Added <${label}> to context`);
              },
            },
          ],
        });
      }
      else if (message.method === "form.submit" || message.method === "action.trigger") {
        const actionId = String(params.actionId ?? "submit");
        const formData = (params.formData ?? params.payload ?? {}) as Record<string, unknown>;
        respond(message, { ok: true, timestamp: Date.now() });
        toast.success(`Form action: ${actionId}`);
        callbacksRef.current.onFormSubmit?.({ actionId, formData });
        if (callbacksRef.current.onCompose) {
          const summary = Object.entries(formData)
            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join(", ");
          callbacksRef.current.onCompose(`[Action ${actionId}] ${summary}`);
        }
      }
      else if (message.method === "context.pick") {
        const label = String(params.label ?? "").trim().slice(0, 160);
        const sourceText = String(params.sourceText ?? "");
        const range = uniqueSourceTextRange(contentRef.current, sourceText);
        if (!label || !range) {
          toast.error(!label ? "Renderer returned an empty context label" : "Renderer context source is missing or ambiguous");
          return;
        }
        const frame = iframeRef.current?.getBoundingClientRect();
        const x = (frame?.left ?? 0) + Number(params.x ?? 0);
        const y = (frame?.top ?? 0) + Number(params.y ?? 0);
        open({
          anchor: pointRect(x, y),
          source: "pointer",
          restoreFocus: iframeRef.current,
          actions: [{
            id: "add-context",
            label: `Add ${label} to context`,
            icon: <AddContextIcon className="h-4 w-4" />,
            run: () => {
              const item = rangedFileContextItem(path, range.start, range.end);
              addContext(channelId, { ...item, label });
              toast.success(`Added ${label} (lines ${range.start}-${range.end}) to context`);
              iframeRef.current?.contentWindow?.postMessage({
                jsonrpc: "2.0",
                method: "context.added",
                params: { requestId: params.requestId, label, startLine: range.start, endLine: range.end },
              }, "*");
            },
          }],
        });
      }
      else if (message.method === "file.save") {
        if (!extension.manifest.permissions?.["file.write"]) return respond(message, undefined, "file.write permission denied");
        fs.write(path, String(params.content ?? ""), versionRef.current)
          .then((result) => { versionRef.current = result.version; respond(message, result); })
          .catch((reason) => respond(message, undefined, reason instanceof Error ? reason.message : String(reason)));
      } else if (message.method === "channel.read") {
        const resource = String(params.resource ?? "");
        if (!extension.manifest.permissions?.["channel.resources"]?.includes(resource)) return respond(message, undefined, "channel resource permission denied");
        callbacksRef.current.readChannel(resource, (params.params as Record<string, unknown>) ?? {}).then((result) => respond(message, result)).catch((reason) => respond(message, undefined, String(reason)));
      } else if (message.method === "navigation.open") {
        if (!extension.manifest.permissions?.["navigation.open"]) return respond(message, undefined, "navigation.open permission denied");
        callbacksRef.current.onOpen?.(String(params.uri ?? "")); respond(message, null);
      } else if (message.method === "composer.prefill") {
        if (!extension.manifest.permissions?.["composer.prefill"]) return respond(message, undefined, "composer.prefill permission denied");
        callbacksRef.current.onCompose?.(String(params.text ?? "").slice(0, 4000)); respond(message, null);
      } else if (message.method === "automation.list") {
        if (!extension.manifest.permissions?.["automation.manage"]) return respond(message, undefined, "automation.manage permission denied");
        void extensionTasks().then((tasks) => respond(message, tasks)).catch((reason) => respond(message, undefined, String(reason)));
      } else if (message.method === "automation.create") {
        if (!extension.manifest.permissions?.["automation.manage"]) return respond(message, undefined, "automation.manage permission denied");
        const automationId = String(params.automationId ?? "");
        const contribution = extension.manifest.automations?.find((automation) => automation.id === automationId);
        if (!contribution) return respond(message, undefined, "unknown automation contribution");
        if (!window.confirm(`Create scheduled task from ${extension.title}: ${contribution.title}?`)) return respond(message, undefined, "user cancelled automation creation");
        try {
          void createScheduledMessage(automationInput(params.input, automationId)).then((task) => respond(message, task)).catch((reason) => respond(message, undefined, String(reason)));
        } catch (reason) { respond(message, undefined, String(reason)); }
      } else if (message.method === "automation.update") {
        if (!extension.manifest.permissions?.["automation.manage"]) return respond(message, undefined, "automation.manage permission denied");
        const taskId = String(params.taskId ?? "");
        void extensionTasks().then(async (tasks) => {
          const current = tasks.find((task) => task.id === taskId);
          if (!current?.sourceAutomationId) throw new Error("scheduled task is not owned by this extension");
          if (!window.confirm(`Update scheduled task "${current.title}"?`)) throw new Error("user cancelled automation update");
          return updateScheduledMessage(taskId, automationInput(params.input, current.sourceAutomationId));
        }).then((task) => respond(message, task)).catch((reason) => respond(message, undefined, String(reason)));
      } else if (message.method === "automation.delete" || message.method === "automation.run") {
        if (!extension.manifest.permissions?.["automation.manage"]) return respond(message, undefined, "automation.manage permission denied");
        const taskId = String(params.taskId ?? "");
        void extensionTasks().then(async (tasks) => {
          const current = tasks.find((task) => task.id === taskId);
          if (!current) throw new Error("scheduled task is not owned by this extension");
          const action = message.method === "automation.delete" ? "Delete" : "Run";
          if (!window.confirm(`${action} scheduled task "${current.title}"?`)) throw new Error(`user cancelled automation ${action.toLowerCase()}`);
          if (message.method === "automation.delete") {
            await deleteScheduledMessage(taskId);
            return null;
          }
          return runScheduledMessageNow(taskId);
        }).then((result) => respond(message, result)).catch((reason) => respond(message, undefined, String(reason)));
      } else if (message.method === "renderer.unsupported") {
        respond(message, null); void fail(String(params.reason ?? "Unsupported content"));
      } else if (message.method === "renderer.failed") {
        void fail(String(params.message ?? "Activation failed"));
      }
    };
    window.addEventListener("message", handler);
    return () => {
      alive = false;
      void dispose();
      for (const pending of pendingRequests.values()) pending.reject(new Error("renderer disposed"));
      pendingRequests.clear();
      window.removeEventListener("message", handler);
      if (!failedRef.current) reportRendererStatus(extension.extensionId, "ready");
    };
  }, [active, addContext, channelId, extension, fs, open, path, rendererId]);

  if (!active) return null;
  if (status === "failed") return <div className="p-3 text-warning-400 text-compact">Renderer failed: {error}. Showing Raw is still available.</div>;
  return <iframe ref={iframeRef} sandbox="allow-scripts" srcDoc={document} title={`${extension.title} (${status})`} className="h-full w-full border-0 bg-white" />;
}
