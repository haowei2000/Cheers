import { useEffect, useMemo, useRef, useState } from "react";
import { A2uiSurface, type ReactCatalogComponent } from "@a2ui/react";
import type { ActionPayload, SurfaceModel } from "@a2ui/web_core";
import { useResourceDraft, ResourceDraftFeedback } from "../../useResourceDraft";
import { ExecutionTerminal } from "../../../RemoteTerminal";
import type { LensProps } from "../registry";
import type { WorkbenchInteraction } from "../../interaction";
import { formatLocator } from "../../../locator";
import { createA2UIProcessor, pointerSegments, readBinding } from "./document";

function resolveContextValue(value: unknown, data: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveContextValue(item, data));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["@path"] === "string" || typeof obj.path === "string") {
      return readBinding(obj, data);
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveContextValue(v, data)]));
  }
  return value;
}

function SurfaceHost({
  surface,
  host,
  onRegisterAction,
}: {
  surface: SurfaceModel<ReactCatalogComponent>;
  host: LensProps;
  onRegisterAction: (surfaceId: string, handler: (action: ActionPayload) => Promise<void>) => void;
}) {
  const initialData = useMemo(() => {
    const raw = surface.dataModel.get("/");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  }, [surface]);

  const schemaKey = useMemo(() => {
    const ids = Array.from(surface.componentsModel.entries, ([id]) => id).sort().join("|");
    let hash = 2166136261;
    for (const char of ids) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `a2ui:${surface.id}:${(hash >>> 0).toString(16)}`;
  }, [surface]);

  const savedDraft = useResourceDraft(host.resourceUri, host.sourceVersion, schemaKey, initialData);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [executionId, setExecutionId] = useState<string>();
  const busy = useRef(false);
  const invocations = useRef(new Map<string, string>());
  const appliedDraft = useRef(false);

  // Restore persisted draft into the A2UI DataModel once per surface mount.
  useEffect(() => {
    if (appliedDraft.current) return;
    appliedDraft.current = true;
    const saved = savedDraft.data;
    if (!saved || typeof saved !== "object") return;
    for (const [key, val] of Object.entries(saved)) {
      if (key.startsWith("/")) {
        try {
          pointerSegments(key);
          surface.dataModel.set(key, val);
        } catch {
          // Ignore invalid legacy draft path
        }
      }
    }
  }, [surface, savedDraft.data]);

  // Persist DataModel updates into Cheers' per-user resource draft.
  useEffect(() => {
    const sub = surface.dataModel.subscribe("/", (next) => {
      if (next && typeof next === "object" && !Array.isArray(next)) {
        savedDraft.setData(next as Record<string, unknown>);
      }
    });
    return () => sub.unsubscribe();
  }, [surface, savedDraft]);

  useEffect(() => {
    onRegisterAction(surface.id, async (action: ActionPayload) => {
      if (busy.current) return;
      const data = (surface.dataModel.get("/") as Record<string, unknown>) ?? {};
      const context = resolveContextValue(action.context ?? {}, data) as Record<string, unknown>;
      let intent: WorkbenchInteraction;

      if (action.name === "cheers.open" || action.name === "cheers.openNative") {
        intent = {
          kind: action.name === "cheers.openNative" ? "openNative" : "open",
          uri: typeof context.uri === "string" ? context.uri : "",
          ...(action.name === "cheers.openNative" ? { opener: String(context.opener ?? "") } : {}),
        } as WorkbenchInteraction;
      } else if (action.name === "cheers.compose" || action.name === "cheers.request" || action.name === "cheers.execute") {
        const payload = (context.payload && typeof context.payload === "object" ? context.payload : {}) as Record<string, unknown>;
        const formData = resolveContextValue(payload, data) as Record<string, unknown>;
        if (action.name === "cheers.compose") {
          intent = { kind: "compose", actionId: String(context.actionId ?? ""), formData };
        } else {
          if (!host.path || !host.sourceVersion) {
            setFeedback({ error: true, text: "Save and reload this resource before sending a request." });
            return;
          }
          const identity = JSON.stringify([action.sourceComponentId, host.sourceVersion, formData]);
          const invocationId = invocations.current.get(identity) ?? crypto.randomUUID();
          invocations.current.set(identity, invocationId);
          intent = {
            kind: action.name === "cheers.execute" ? "execute" : "request",
            event: {
              v: 1,
              sourceUri: host.resourceUri ?? formatLocator({ kind: "desk", path: host.path }),
              sourceVersion: host.sourceVersion,
              surfaceId: surface.id,
              componentId: action.sourceComponentId,
              actionId: String(context.actionId ?? ""),
              botId: String(context.botId ?? ""),
              invocationId,
              input: formData,
            },
          };
        }
      } else {
        setFeedback({ error: false, text: `Action "${action.name}" triggered.` });
        return;
      }

      busy.current = true;
      try {
        const result = await host.onInteraction?.(intent);
        if (result?.ok && result.executionId) setExecutionId(result.executionId);
        setFeedback(
          !result
            ? { error: true, text: "This interaction is unavailable in this view." }
            : result.ok
              ? {
                  error: false,
                  text:
                    result.outcome === "drafted"
                      ? "Draft added to the chat composer. Review it before sending."
                      : result.outcome === "executing"
                        ? "Execution accepted. Its terminal and status appear here."
                        : result.outcome === "requested"
                          ? "Request sent to the Bot. Its resource update will appear here."
                          : result.outcome === "local"
                            ? "Original file opened on this device."
                            : result.outcome === "downloaded-copy"
                              ? "Downloaded copy opened. Edits in the external application do not sync back."
                              : "Resource navigation requested.",
                }
              : { error: true, text: result.error },
        );
      } catch (error) {
        setFeedback({ error: true, text: error instanceof Error ? error.message : "The interaction failed. Try again." });
      } finally {
        busy.current = false;
      }
    });
  }, [surface, host, onRegisterAction]);

  return (
    <section
      aria-label={`Interactive surface ${surface.id}`}
      className="space-y-4"
      onContextMenu={(event) => {
        if (!host.requestContextPick) return;
        event.preventDefault();
        event.stopPropagation();
        host.requestContextPick(event, { label: surface.id, sourcePath: ["messages"] });
      }}
    >
      {typeof document === "undefined" ? (
        <div data-a2ui-surface={surface.id}>
          {Array.from(surface.componentsModel.entries, ([id, comp]) => {
            const tag = `a2ui-${comp.type.toLowerCase()}`;
            return <div key={id} data-a2ui-component={tag} data-a2ui-id={id} />;
          })}
        </div>
      ) : (
        <A2uiSurface surface={surface} />
      )}
      {executionId && <ExecutionTerminal executionId={executionId} />}
      <ResourceDraftFeedback draft={savedDraft} />
      {feedback && (
        <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "text-body-error" : "text-body-secondary"}>
          {feedback.text}
        </p>
      )}
    </section>
  );
}

/** Renders A2UI documents using Google's official `@a2ui/react` and `@a2ui/web_core`
 * Basic Catalog while preserving Cheers' host interaction bridge and local draft persistence. */
export function A2UILens(props: LensProps) {
  const actionHandlers = useRef(new Map<string, (action: ActionPayload) => Promise<void>>());
  const registerAction = useMemo(
    () => (surfaceId: string, handler: (action: ActionPayload) => Promise<void>) => {
      actionHandlers.current.set(surfaceId, handler);
    },
    [],
  );

  const presentation = props.presentation ?? "max";
  const ssrParsed = useMemo(() => {
    if (typeof document !== "undefined") return null;
    try {
      return { ...createA2UIProcessor(props.data, { presentation }), error: null as string | null };
    } catch (error) {
      return { processor: null, surfaces: [] as SurfaceModel<ReactCatalogComponent>[], fits: true, error: error instanceof Error ? error.message : "Invalid A2UI document." };
    }
  }, [props.data, presentation]);

  const [clientParsed, setClientParsed] = useState<{
    processor: ReturnType<typeof createA2UIProcessor>["processor"] | null;
    surfaces: SurfaceModel<ReactCatalogComponent>[];
    fits: boolean;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let disposed = false;
    let activeProcessor: ReturnType<typeof createA2UIProcessor>["processor"] | null = null;
    try {
      const result = createA2UIProcessor(props.data, {
        presentation,
        onAction: async (action) => {
          const handler = actionHandlers.current.get(action.surfaceId);
          if (handler) await handler(action);
        },
      });
      activeProcessor = result.processor;
      if (!disposed) {
        setClientParsed({ ...result, error: null });
      }
    } catch (error) {
      if (!disposed) {
        setClientParsed({
          processor: null,
          surfaces: [],
          fits: true,
          error: error instanceof Error ? error.message : "Invalid A2UI document.",
        });
      }
    }
    return () => {
      disposed = true;
      activeProcessor?.dispose();
    };
  }, [props.data, presentation]);

  const parsed = typeof document === "undefined" ? ssrParsed! : clientParsed;
  if (!parsed) return null;

  if (parsed.error) {
    return <div role="alert" className="p-4 text-body-error">{parsed.error} Open Raw to correct the document.</div>;
  }
  if (!parsed.fits) {
    return <p className="text-body-secondary">This form needs more space. Expand the preview to use all its controls.</p>;
  }

  return (
    <div
      data-presentation={presentation}
      className={
        presentation === "minimal" || presentation === "medium"
          ? "min-w-0 space-y-4 font-utility text-regular"
          : "h-full min-w-0 space-y-8 overflow-auto p-4 font-utility text-regular"
      }
    >
      {!props.onInteraction && <p className="text-body-secondary">Actions are unavailable in this view.</p>}
      {!parsed.surfaces.length && <p className="text-body-secondary">This document has no active surfaces. Open Raw to inspect it.</p>}
      {parsed.surfaces.map((surface) => (
        <SurfaceHost
          key={`${surface.id}:${props.sourceVersion ?? 0}:${JSON.stringify(props.data)}`}
          surface={surface}
          host={props}
          onRegisterAction={registerAction}
        />
      ))}
    </div>
  );
}
