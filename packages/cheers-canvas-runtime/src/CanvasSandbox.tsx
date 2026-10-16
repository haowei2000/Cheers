import { useEffect, useRef, type ReactNode } from "react";
import type { PresentationLevel } from "./types.ts";
import { boundedPayload, boundedText } from "./bridge.ts";

export interface CanvasSandboxProps {
  srcDoc: string;
  title?: string;
  className?: string;
  inspectorActive?: boolean;
  readOnly?: boolean;
  presentation?: PresentationLevel;
  onFormSubmit?: (data: { actionId: string; formData: Record<string, unknown> }) => void;
  onTrigger?: (data: { actionId: string; payload: Record<string, unknown> }) => void;
  onRequest?: (data: { actionId: string; payload: Record<string, unknown> }) => void;
  onInspect?: (params: {
    x: number;
    y: number;
    label: string;
    domPath: string;
    sourceText: string;
    inspectableId?: string;
    sourceLine?: number;
    sourceUri?: string;
    frameRect?: DOMRect;
  }) => void;
  onCanvasMove?: (params: { id: string; x: number; y: number }) => void;
  onContextPick?: (params: {
    x: number;
    y: number;
    label: string;
    domPath: string;
    sourceText: string;
    inspectableId?: string;
    sourceLine?: number;
    sourceUri?: string;
    frameRect?: DOMRect;
  }) => void;
  onMessage?: (event: MessageEvent) => void;
  children?: ReactNode;
}

export function CanvasSandbox({
  srcDoc,
  title = "Canvas Sandbox",
  className = "h-full w-full border-0",
  inspectorActive = false,
  readOnly = false,
  presentation = "minimal",
  onFormSubmit,
  onTrigger,
  onRequest,
  onInspect,
  onCanvasMove,
  onContextPick,
  onMessage,
  children,
}: CanvasSandboxProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "inspector.toggle",
        params: {
          enabled: Boolean(inspectorActive && presentation !== "minimal"),
          editable: !readOnly,
        },
      },
      "*",
    );
  }, [inspectorActive, presentation, readOnly]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        !event.data ||
        typeof event.data !== "object" ||
        event.data.jsonrpc !== "2.0"
      ) {
        return;
      }

      onMessage?.(event);

      const { method, params } = event.data;
      if (!params || typeof params !== "object" || Array.isArray(params)) return;

      if (method === "inspector.inspect" || method === "context.pick") {
        const frameRect = iframeRef.current?.getBoundingClientRect();
        const x = Number(params.x);
        const y = Number(params.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100_000 || Math.abs(y) > 100_000) return;

        const payload = {
          x,
          y,
          label: boundedText(params.label, 120).trim() || "element",
          sourceText: boundedText(params.sourceText, 500),
          domPath: boundedText(params.domPath, 1000),
          inspectableId: boundedText(params.inspectableId, 128) || undefined,
          sourceLine: Number(params.sourceLine) || undefined,
          sourceUri: boundedText(params.sourceUri, 2048) || undefined,
          frameRect,
        };

        if (method === "inspector.inspect") onInspect?.(payload);
        else onContextPick?.(payload);
      } else if (method === "canvas.move") {
        const id = boundedText(params.id, 128);
        const x = Number(params.x);
        const y = Number(params.y);
        onCanvasMove?.({ id, x, y });
      } else if (method === "form.submit" || method === "action.trigger" || method === "cheers.request") {
        const actionId = boundedText(params.actionId, 80) || "submit";
        const formData = boundedPayload(params.formData ?? params.payload ?? {});
        if (!formData) return;

        if (method === "cheers.request") {
          onRequest?.({ actionId, payload: formData });
        } else if (method === "action.trigger") {
          onTrigger?.({ actionId, payload: formData });
        } else {
          onFormSubmit?.({ actionId, formData });
        }
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onCanvasMove, onContextPick, onFormSubmit, onInspect, onMessage, onRequest, onTrigger]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-forms"
        srcDoc={srcDoc}
        onLoad={() =>
          iframeRef.current?.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              method: "inspector.toggle",
              params: { enabled: Boolean(inspectorActive), editable: !readOnly },
            },
            "*",
          )
        }
        title={title}
        className={className}
      />
      {children}
    </div>
  );
}
