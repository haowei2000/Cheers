import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import type { LensProps } from "../registry";
import type { WorkbenchInteraction } from "../../interaction";
import { formatLocator } from "../../../locator";
import { a2uiPresentation, parseA2UIDocument, readBinding, setDataPath, type A2UIComponent, type A2UISurface } from "./document";

function SurfaceView({ surface, host, root }: { surface: A2UISurface; host: LensProps; root: string }) {
  const prefix = useId();
  const controlSize = host.presentation === "minimal" ? "compact" : "regular";
  const spacing = host.presentation === "minimal" ? "gap-2" : "gap-4";
  const [draft, setDraft] = useState(surface.data);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const invocations = useRef(new Map<string, string>());
  const text = (value: unknown) => {
    const resolved = readBinding(value, draft);
    return typeof resolved === "string" || typeof resolved === "number" || typeof resolved === "boolean" ? String(resolved) : "";
  };
  const change = (node: A2UIComponent, value: string | boolean) => {
    try {
      const path = (node.value as { path: string }).path;
      setDraft(setDataPath(draft, path, value));
      setFeedback(null);
    } catch (error) {
      setFeedback({ error: true, text: error instanceof Error ? error.message : "The input could not be updated." });
    }
  };
  const activate = async (node: A2UIComponent) => {
    if (busy.current) return;
    const event = node.action!.event;
    const context = Object.fromEntries(Object.entries(event.context).map(([key, value]) => [key, readBinding(value, draft)]));
    let intent: WorkbenchInteraction;
    if (event.name === "cheers.open" || event.name === "cheers.openNative") {
      intent = { kind: "open", uri: typeof context.uri === "string" ? context.uri : "" };
      if (event.name === "cheers.openNative") intent = { ...intent, kind: "openNative", opener: String(context.opener) };
    } else {
      const payload = event.context.payload as Record<string, unknown>;
      const formData = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, readBinding(value, draft)]));
      intent = { kind: "compose", actionId: String(context.actionId), formData };
      if (event.name === "cheers.request") {
        if (!host.path || !host.sourceVersion) {
          setFeedback({ error: true, text: "Save and reload this resource before sending a request." });
          return;
        }
        const identity = JSON.stringify([node.id, host.sourceVersion, formData]);
        const invocationId = invocations.current.get(identity) ?? crypto.randomUUID();
        invocations.current.set(identity, invocationId);
        intent = { kind: "request", event: { v: 1, sourceUri: formatLocator({ kind: "desk", path: host.path }), sourceVersion: host.sourceVersion,
          surfaceId: surface.id, componentId: node.id, actionId: String(context.actionId), botId: String(context.botId), invocationId, input: formData } };
      }
    }
    busy.current = true;
    setPending(true);
    let result;
    try {
      result = await host.onInteraction?.(intent);
    } catch (error) {
      result = { ok: false as const, error: error instanceof Error ? error.message : "The interaction failed. Try again." };
    } finally {
      busy.current = false;
      setPending(false);
    }
    setFeedback(!result
      ? { error: true, text: "This interaction is unavailable in this view." }
      : result.ok
        ? { error: false, text: result.outcome === "drafted" ? "Draft added to the chat composer. Review it before sending."
          : result.outcome === "requested" ? "Request sent to the Bot. Its resource update will appear here."
          : result.outcome === "local" ? "Original file opened on this device."
          : result.outcome === "downloaded-copy" ? "Downloaded copy opened. Edits in the external application do not sync back."
          : "Resource navigation requested." }
        : { error: true, text: result.error });
  };
  const render = (id: string): ReactNode => {
    const node = surface.components.get(id)!;
    let content: ReactNode;
    if (node.component === "Column" || node.component === "Row") {
      content = <div className={`${node.component === "Row" ? "flex min-w-0 flex-wrap items-start" : "flex min-w-0 flex-col"} ${spacing}`}>{node.children!.map(render)}</div>;
    } else if (node.component === "Text") {
      content = <p className={host.presentation === "minimal" ? "line-clamp-3 whitespace-pre-wrap break-words font-reading text-regular leading-reading text-content-primary" : "whitespace-pre-wrap break-words font-reading text-regular leading-reading text-content-primary"}>{text(node.text)}</p>;
    } else if (node.component === "TextField") {
      const inputId = `${prefix}-${node.id}`;
      content = <Field htmlFor={inputId} label={text(node.label) || "Text input"} className="min-w-0">
        <Input variant="plain" id={inputId} controlSize={controlSize} disabled={pending} value={text(node.value)} onChange={(event) => change(node, event.target.value)} />
      </Field>;
    } else if (node.component === "CheckBox") {
      content = <CheckboxField controlSize={controlSize} disabled={pending} label={text(node.label) || "Option"} checked={readBinding(node.value, draft) === true} onChange={(event) => change(node, event.target.checked)} />;
    } else {
      const label = text(node.label);
      const name = node.action!.event.name;
      const kind = name.slice("cheers.".length) as WorkbenchInteraction["kind"];
      const available = host.onInteraction?.capabilities.includes(kind);
      content = <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="break-words font-reading text-regular leading-reading text-content-secondary">{label}</span>
        <Button action={kind === "open" || kind === "openNative" ? "open" : "request"} variant={host.presentation === "minimal" || kind === "open" || kind === "openNative" ? "plain" : "emphasis"} controlSize={controlSize} aria-label={label || "Card action"} disabled={!available || pending} loading={pending} onClick={() => void activate(node)} />
        {kind === "request" && <span className="text-body-secondary">Sends a request to the declared Bot.</span>}
        {!available && <span className="text-body-secondary">This action is unavailable on this client.</span>}
      </div>;
    }
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- Optional source picking delegates to the existing host context menu; actual actions use native controls.
    return <div key={node.id} className="min-w-0" onContextMenu={(event) => {
      if (!host.requestContextPick) return;
      event.preventDefault();
      event.stopPropagation();
      host.requestContextPick(event, { label: text(node.label ?? node.text) || node.id, sourcePath: node.sourcePath });
    }}>{content}</div>;
  };
  return <section aria-label={`Interactive surface ${surface.id}`} className="space-y-4">
    {render(root)}
    {feedback && <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "text-body-error" : "text-body-secondary"}>{feedback.text}</p>}
  </section>;
}

/** Uses the existing file session and lens host. Input is a local draft, never
 * a whole-document onChange or an implicit native/tool invocation. */
export function A2UILens(props: LensProps) {
  const parsed = useMemo(() => {
    try { return { surfaces: parseA2UIDocument(props.data), error: null }; }
    catch (error) { return { surfaces: [], error: error instanceof Error ? error.message : "Invalid A2UI document." }; }
  }, [props.data]);
  if (parsed.error) return <div role="alert" className="p-4 text-body-error">{parsed.error} Open Raw to correct the document.</div>;
  const presentation = a2uiPresentation(props.data, parsed.surfaces, props.presentation ?? "max");
  if (!presentation.fits) return <p className="text-body-secondary">This form needs more space. Expand the preview to use all its controls.</p>;
  return <div data-presentation={props.presentation ?? "max"} className={props.presentation === "minimal" || props.presentation === "medium"
    ? "min-w-0 space-y-4 font-utility text-regular" : "h-full min-w-0 space-y-8 overflow-auto p-4 font-utility text-regular"}>
    {!props.onInteraction && <p className="text-body-secondary">Actions are unavailable in this view.</p>}
    {!parsed.surfaces.length && <p className="text-body-secondary">This document has no active surfaces. Open Raw to inspect it.</p>}
    {presentation.selected.map(({ surface, root }) => <SurfaceView key={`${surface.id}:${props.sourceVersion}:${JSON.stringify(props.data)}`} surface={surface} root={root} host={props} />)}
  </div>;
}
