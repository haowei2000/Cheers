import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { LensProps } from "./registry";
import { formatLocator, parseLocator, validInspectableId } from "../../locator";
import type { ResourceInteraction } from "../interaction";
import { useResourceDraft,ResourceDraftFeedback } from "../useResourceDraft";
import { ExecutionLink } from "../../RemoteTerminal";
import { Button } from "@/components/ui/button";
import { createArtifactRequestGate, type ArtifactRequestState } from "./artifactRequestGate";
import { inspectableIdLineRange } from "../contextSource";
import { Code2 } from "lucide-react";
import { moveCodeCanvasCard } from "./codeCanvasSource";
import { MAX_ARTIFACT_SOURCE_LENGTH } from "./artifactLimits";
import reactRuntime from "virtual:artifact-react-runtime";
import canvasStyles from "@/index.css?inline";
import {
  artifactCsp,
  boundedPayload,
  boundedText,
  BRIDGE_SCRIPT,
  escapeHtml,
  escapeScript,
  extractTsxActions,
  INSPECTOR_CSS,
} from "@cheers/canvas-runtime";

export { artifactCsp };

export interface ArtifactLensProps extends LensProps {
  mode: "html" | "react";
}


export function buildArtifactHtml(source: string, mode: "html" | "react", compiledCode?: string, compileError?: string): string {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${artifactCsp()}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${canvasStyles}\n${INSPECTOR_CSS}\nhtml,body{min-height:100vh}body{color:#1f2937;background:#fff}</style><script>${escapeScript(BRIDGE_SCRIPT)}</script>`;

  if (mode === "html") {
    const body = source.length > MAX_ARTIFACT_SOURCE_LENGTH
      ? "<p>Preview source is too large</p>"
      : source.trim() || "<p>Empty HTML Canvas</p>";
    // The policy must appear before any authored markup, including a full HTML document.
    return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  }

  const status = compileError
    ? `<p role="alert">${escapeHtml(compileError)}</p>`
    : "<p>Compiling preview…</p>";
  const app = compiledCode ? `(() => {
    try {
      const { useState, useEffect, useRef, useMemo, useCallback } = React;
      const exports = {};
      const module = { exports };
      ${compiledCode}
      const Component = window.__CHEERS_ROOT_COMPONENT__ || window.App || window.Main;
      const rootEl = document.getElementById("root");
      if (Component && rootEl) ReactDOM.createRoot(rootEl).render(React.createElement(Component));
      else if (rootEl) rootEl.textContent = "Provide an export default React component to preview.";
    } catch (error) {
      const rootEl = document.getElementById("root");
      if (rootEl) rootEl.textContent = "React Render Error: " + String(error);
    }
  })();` : "";
  return `<!doctype html><html><head>${head}<style>html,body,#root{height:100vh;margin:0;padding:0}</style></head>
<body><div id="root">${compiledCode ? "" : status}</div>
<script>${escapeScript(reactRuntime)}</script>
${compiledCode ? `<script>${escapeScript(app)}</script>` : ""}</body></html>`;
}

export function ArtifactLens({
  data,
  path,
  artifactId,
  sourceVersion,
  resourceUri,

  mode,
  presentation,
  inspectorActive,
  requestContextPick,
  onFormSubmit,
  onInteraction,
  openLocator,
  onChange,
  readOnly,
}: ArtifactLensProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const content = typeof data === "string" ? data : "";
  const [requestState, setRequestState] = useState<ArtifactRequestState>({ busy: false });
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const requestGate = useMemo(() => {
    // Bind approval to the observed source, invalidating it on any revision change.
    const source = { content, path, sourceVersion,resourceUri };
    return createArtifactRequestGate((event) => {
      if (event.sourceVersion !== source.sourceVersion || !source.path || (source.resourceUri && event.sourceUri!==source.resourceUri)) {
        return Promise.resolve({ ok: false, error: "The source changed. Reload before submitting." });
      }
      return onInteraction!({ kind:extractTsxActions(source.content).find(a=>a.actionId===event.actionId)?.name==="cheers.execute"?"execute":"request", event });
    }, setRequestState);
  }, [content, path, sourceVersion, resourceUri, onInteraction]);
  useEffect(() => {
    requestGate.activate();
    setRequestState({ busy: false });
    setFeedback(null);
    return () => requestGate.dispose();
  }, [requestGate]);
  const savedDraft=useResourceDraft(resourceUri,sourceVersion,"tsx:root",{fields:{},custom:{}});
  const draftRef=useRef(savedDraft);draftRef.current=savedDraft;
  const restoreDraft=()=>iframeRef.current?.contentWindow?.postMessage({jsonrpc:"2.0",method:"view.state.restore",params:{data:draftRef.current.data,ready:!draftRef.current.enabled||draftRef.current.state.loaded||draftRef.current.state.status==="offline"}},"*");
  useEffect(()=>{restoreDraft();},[savedDraft.data,savedDraft.enabled,savedDraft.state.loaded,savedDraft.state.status]);
  const [compiled, setCompiled] = useState<{ source: string; code?: string; error?: string } | null>(null);
  useEffect(() => {
    if (mode !== "react") return;
    if (content.length > MAX_ARTIFACT_SOURCE_LENGTH) {
      setCompiled({ source: content, error: "Preview source is too large" });
      return;
    }
    const worker = new Worker(new URL("./artifactCompiler.worker.ts", import.meta.url), { type: "module" });
    const timeout = window.setTimeout(() => {
      worker.terminate();
      setCompiled({ source: content, error: "Preview compilation timed out" });
    }, 8000);
    worker.onmessage = (event: MessageEvent<{ code?: string; error?: string }>) => {
      window.clearTimeout(timeout);
      setCompiled({ source: content, code: event.data.code, error: event.data.error });
      worker.terminate();
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      setCompiled({ source: content, error: "Preview compiler failed" });
      worker.terminate();
    };
    worker.postMessage({ source: content });
    return () => { window.clearTimeout(timeout); worker.terminate(); };
  }, [content, mode]);
  const currentCompiled = compiled?.source === content ? compiled : null;
  const documentHtml = useMemo(
    () => buildArtifactHtml(content, mode, currentCompiled?.code, currentCompiled?.error),
    [content, mode, currentCompiled?.code, currentCompiled?.error],
  );

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({
      jsonrpc: "2.0",
      method: "inspector.toggle",
      params: { enabled: Boolean(inspectorActive && presentation !== "minimal"), editable: !readOnly },
    }, "*");
  }, [inspectorActive, presentation, readOnly]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !event.data || typeof event.data !== "object" || event.data.jsonrpc !== "2.0") return;
      const { method, params } = event.data;
      if (!params || typeof params !== "object" || Array.isArray(params)) return;

      if(method==="view.fields.write"||method==="view.state.write") {
        const data=boundedPayload(params.data);
        if(data)draftRef.current.setData({...draftRef.current.data,[method==="view.fields.write"?"fields":"custom"]:data});
        return;
      }
      if (method === "inspector.inspect" || method === "context.pick") {
        const frame = iframeRef.current?.getBoundingClientRect();
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return;
        const clientX = (frame?.left ?? 0) + x;
        const clientY = (frame?.top ?? 0) + y;
        const label = boundedText(params.label, 120).trim() || "element";
        const sourceText = boundedText(params.sourceText, 500);
        const domPath = boundedText(params.domPath, 1000);
        const claimedId = boundedText(params.inspectableId, 128);
        const sourceLine = Number(params.sourceLine);
        const sourceUri = boundedText(params.sourceUri, 2048);
        const related = parseLocator(sourceUri);
        const relatedUri = related?.kind === "ws" || related?.kind === "desk" ? sourceUri : undefined;
        const inspectableId = path && validInspectableId(claimedId) && inspectableIdLineRange(content, claimedId)
          ? claimedId
          : undefined;
        const locator = inspectableId && path
          ? formatLocator(artifactId ? { kind: "artifact", artifactId, inspectableId } : { kind: "desk", path, inspectableId })
          : undefined;

        const fakeEvent = {
          clientX,
          clientY,
          preventDefault: () => {},
          stopPropagation: () => {},
          currentTarget: iframeRef.current,
        } as unknown as React.MouseEvent<Element>;

        requestContextPick?.(fakeEvent, {
          label: `<${label}>`,
          locator,
          inspectableId,
          sourceLine: Number.isSafeInteger(sourceLine) && sourceLine > 0 ? sourceLine : undefined,
          sourceText: inspectableId ? undefined : sourceText || undefined,
          sourcePath: inspectableId ? undefined : domPath ? [domPath] : undefined,
          extraActions: relatedUri && openLocator ? [{
            id: "open-related-code",
            label: "Open related code",
            icon: <Code2 className="h-4 w-4" />,
            run: () => openLocator(relatedUri),
          }] : undefined,
        });
      } else if (method === "canvas.move") {
        if (readOnly || !inspectorActive || presentation === "minimal") {
          iframeRef.current?.contentWindow?.postMessage({ jsonrpc: "2.0", method: "canvas.revert" }, "*");
          return;
        }
        const id = boundedText(params.id, 128);
        const x = Number(params.x);
        const y = Number(params.y);
        const next = moveCodeCanvasCard(content, id, x, y);
        if (next !== null) onChange(next);
        else {
          iframeRef.current?.contentWindow?.postMessage({ jsonrpc: "2.0", method: "canvas.revert" }, "*");
          toast.error("Card position could not be written to source");
        }
      } else if (method === "form.submit" || method === "action.trigger" || method === "cheers.request" || method==="cheers.execute") {
        const actionId = boundedText(params.actionId, 80) || "submit";
        const formData = boundedPayload(params.formData ?? params.payload ?? {});
        if (!formData) return;

        const declared = extractTsxActions(content).find((a) => a.actionId === actionId);

        if (
          (method === "cheers.request" || declared?.name === "cheers.request" || method==="cheers.execute" || declared?.name==="cheers.execute") &&
          onInteraction &&
          onInteraction.capabilities.includes(declared?.name==="cheers.execute"?"execute":"request") &&
          path &&
          sourceVersion &&
          declared?.botId
        ) {
          const event: ResourceInteraction = {
            v: 1,
            sourceUri: resourceUri ?? formatLocator({ kind: "desk", path }),
            sourceVersion,
            surfaceId: "root",
            componentId: actionId,
            actionId,
            botId: declared.botId,
            invocationId: crypto.randomUUID(),
            input: formData,
          };
          requestGate.propose(event);
          return;
        }

        if (method === "cheers.request" || declared?.name === "cheers.request" || method==="cheers.execute" || declared?.name==="cheers.execute") {
          setFeedback({ ok: false, text: "This request is unavailable. Reload the resource or open it in a supported view." });
          return;
        }
        if (onInteraction?.capabilities.includes("compose")) {
          void onInteraction({ kind: "compose", actionId, formData }).then((result) => {
            setFeedback(result.ok
              ? { ok: true, text: "Draft prepared in the message composer. Review it before sending." }
              : { ok: false, text: result.error });
          }).catch((error) => setFeedback({ ok: false, text: String(error) }));
        } else if (onFormSubmit) {
          onFormSubmit({ actionId, formData });
          setFeedback({ ok: true, text: "Form passed to the host." });
        } else {
          setFeedback({ ok: false, text: "This view cannot prepare a message draft." });
        }

      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [artifactId, content, inspectorActive, onChange, onFormSubmit, onInteraction, openLocator, path, presentation, readOnly, requestContextPick, sourceVersion, resourceUri, requestGate]);


  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- The titled iframe receives an onLoad synchronization callback for the isolated artifact editor. */
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-panel">
      {/* Form events go through the bridge; CSP blocks outbound submission. */}
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-forms"
        srcDoc={documentHtml}
        onLoad={() => {restoreDraft();iframeRef.current?.contentWindow?.postMessage({
          jsonrpc: "2.0", method: "inspector.toggle", params: { enabled: Boolean(inspectorActive), editable: !readOnly },
        }, "*");}}
        title={`${mode.toUpperCase()} Canvas`}
        className="min-h-0 w-full flex-1 border-0"
      />
      {requestState.result?.ok&&requestState.result.executionId&&<ExecutionLink executionId={requestState.result.executionId}/>}
      <ResourceDraftFeedback draft={savedDraft}/>
      {(requestState.pending || requestState.result || feedback) && <div className="max-h-full shrink-0 overflow-auto">
        {requestState.pending && <div className="space-y-2 p-3">
          <p className="text-body break-words">Review {requestState.pending.actionId} for Bot {requestState.pending.botId}</p>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-code text-regular">{JSON.stringify(requestState.pending.input, null, 2)}</pre>
          <div className="flex items-center gap-2">
            <Button action="request" controlSize="compact" loading={requestState.busy} disabled={requestState.busy}
              onClick={(event) => { void requestGate.confirm(event.nativeEvent.isTrusted); }} />
            <Button action="cancel" controlSize="compact" disabled={requestState.busy} onClick={() => requestGate.cancel()} />
          </div>
      </div>}
      {requestState.result && <p role={requestState.result.ok ? "status" : "alert"} className={`p-3 ${requestState.result.ok ? "text-body-secondary" : "text-body-error"}`}>
        {requestState.result.ok ? requestState.result.executionId ? "Execution accepted. Open the terminal to follow its result." : "Request accepted. The Bot will reply in the channel." : `${requestState.result.error} Retry above, or reload if the source changed.`}
      </p>}
      {feedback && <p role={feedback.ok ? "status" : "alert"} className={`p-3 ${feedback.ok ? "text-body-secondary" : "text-body-error"}`}>{feedback.text}</p>}
      </div>}
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
}
