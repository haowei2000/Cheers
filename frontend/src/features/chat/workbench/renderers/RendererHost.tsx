import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import type { WorkbenchContext } from "../context";
import type { FileSession } from "../jsonFile";
import type { AnnotationDoc } from "../annotations";
import { annotationsFor } from "../annotations";
import type { LensContextTarget } from "../lens/registry";
import { LensPanel, LensView } from "../lens/LensPanel";
import { SandboxRenderer } from "../sandbox/SandboxRenderer";
import type { RendererDesc } from "./registry";
import { EXTENSION_CHANNEL_RESOURCES } from "../extensions/package";
import { CodeEditor } from "../CodeEditor";

// The channel.* read verbs a renderer extension may call (host API). READ-ONLY and low/medium
// sensitivity. NOTE: a sandboxed iframe is isolated for tokens/DOM but NOT for network — a
// an extension could exfiltrate whatever it is handed. Personal extensions are explicitly
// approved by the user and every read still passes server-side channel-role authz,
// scoped to THIS channel (channel_id is forced below). Keep this list conservative.
//
// This is the gate that actually stops a call, re-checked here rather than trusted from
// install time — but it is the manifest vocabulary itself, not a fourth copy of those
// names. A permission that could be declared, consented to, and then refused here would
// be a promise the host does not keep.
const CHANNEL_READ_WHITELIST = new Set<string>(EXTENSION_CHANNEL_RESOURCES);

interface ErrorBoundaryProps {
  renderer: RendererDesc;
  path: string;
  session?: FileSession;
  annotations?: {
    doc: AnnotationDoc;
    onAnnotate: (target: LensContextTarget, at: { x: number; y: number }) => void;
    onRemove: (id: string) => void;
  };
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (id: string) => void;
  onFailure?: (rendererId: string, reason: string) => void;
  children: ReactNode;
  retryKey: number;
  onRetry: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: string | null;
}

export class RendererErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error: error.message || "Unknown error" };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[RendererErrorBoundary] Renderer crashed:", error, errorInfo);
    this.props.onFailure?.(this.props.renderer.id, error.message || "Renderer crashed");
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (
      prevProps.renderer.id !== this.props.renderer.id ||
      prevProps.path !== this.props.path ||
      prevProps.retryKey !== this.props.retryKey
    ) {
      if (this.state.hasError) {
        this.setState({ hasError: false, error: null });
      }
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <RendererFallbackView
          rendererTitle={this.props.renderer.title}
          reason={this.state.error || "Renderer crashed"}
          path={this.props.path}
          session={this.props.session}
          annotations={this.props.annotations}
          activeAnnotationId={this.props.activeAnnotationId}
          onSelectAnnotation={this.props.onSelectAnnotation}
          onRetry={this.props.onRetry}
        />
      );
    }
    return this.props.children;
  }
}

export function RendererFallbackView({
  rendererTitle,
  reason,
  path,
  session,
  annotations,
  activeAnnotationId,
  onSelectAnnotation,
  onRetry,
}: {
  rendererTitle: string;
  reason: string;
  path: string;
  session?: FileSession;
  annotations?: {
    doc: AnnotationDoc;
    onAnnotate: (target: LensContextTarget, at: { x: number; y: number }) => void;
    onRemove: (id: string) => void;
  };
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (id: string) => void;
  onRetry?: () => void;
}) {
  const fileNotes = useMemo(
    () => (annotations ? annotationsFor(annotations.doc, path) : undefined),
    [annotations, path]
  );

  return (
    <div className="flex flex-col h-full w-full overflow-hidden" data-testid="renderer-fallback">
      <div
        role="alert"
        className="flex items-center justify-between px-3 py-2 bg-panel/90 border-b border-control/40 text-compact text-warning-400 flex-shrink-0"
      >
        <div className="flex items-center gap-2 truncate min-w-0">
          <TriangleAlert className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">
            {rendererTitle} failed: {reason}. Degraded to Raw mode.
          </span>
        </div>
        {onRetry && (
          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            <UiButton
              variant="plain"
              controlSize="compact"
              onClick={onRetry}
              className="text-content-primary hover:bg-control"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" />
              Retry
            </UiButton>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {session ? (
          <CodeEditor
            value={session.text}
            onChange={session.editText}
            path={path}
            notes={fileNotes}
            activeAnnotationId={activeAnnotationId}
            onSelectAnnotation={onSelectAnnotation}
          />
        ) : (
          <div className="p-4 text-content-muted text-compact">
            Source editor unavailable for standalone view.
          </div>
        )}
      </div>
    </div>
  );
}

// Mount the chosen renderer over one file. Built-in => the compiled lens (via a
// synthetic view); extension => the sandboxed render/save host. Both render exactly the
// one `path`; neither learns anything about how the other works.
export function RendererHost({
  ctx,
  path,
  renderer,
  config,
  session,
  annotations,
  activeAnnotationId,
  onSelectAnnotation,
  onRevealSource,
  onFailure,
  inspectorActive,
  onFormSubmit,
}: {
  ctx: WorkbenchContext;
  path: string;
  renderer: RendererDesc;
  config?: unknown; // built-in lens config (e.g. table columns), from .workbench.json configs
  /** The host's file session, when the host ALSO shows this file another way (Raw).
   *  Both views must share one buffer/version/dirty flag. Absent => this is the file's
   *  only view and the lens host opens its own session. */
  session?: FileSession;
  /** Notes on this file plus the host's compose/remove hooks, forwarded to the lens's
   *  right-click menu. Only meaningful alongside `session` — the host that owns one owns
   *  the other. */
  annotations?: {
    doc: AnnotationDoc;
    onAnnotate: (target: LensContextTarget, at: { x: number; y: number }) => void;
    onRemove: (id: string) => void;
  };
  activeAnnotationId?: string | null;
  onSelectAnnotation?: (id: string) => void;
  onRevealSource?: (line: number) => void;
  onFailure?: (rendererId: string, reason: string) => void;
  inspectorActive?: boolean;
  onFormSubmit?: (data: { actionId: string; formData: Record<string, unknown> }) => void;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const handleRetry = useCallback(() => {
    setRuntimeError(null);
    setRetryKey((k) => k + 1);
  }, []);

  const handleFailure = useCallback(
    (rendererId: string, reason: string) => {
      setRuntimeError(reason);
      onFailure?.(rendererId, reason);
    },
    [onFailure]
  );

  const extension = renderer.source === "extension"
    ? ctx.rendererExtensions.find((p) => p.extensionId === renderer.extensionId)
    : undefined;

  const missingExtension = renderer.source === "extension" && !extension;

  useEffect(() => {
    if (missingExtension) {
      handleFailure(renderer.id, `Renderer extension not installed: ${renderer.extensionId}`);
    }
  }, [missingExtension, renderer.id, renderer.extensionId, handleFailure]);

  if (runtimeError) {
    return (
      <RendererFallbackView
        rendererTitle={renderer.title}
        reason={runtimeError}
        path={path}
        session={session}
        annotations={annotations}
        activeAnnotationId={activeAnnotationId}
        onSelectAnnotation={onSelectAnnotation}
        onRetry={handleRetry}
      />
    );
  }

  if (renderer.source === "extension") {
    if (!extension) {
      return (
        <RendererFallbackView
          rendererTitle={renderer.title}
          reason={`Renderer extension not installed: ${renderer.extensionId}`}
          path={path}
          session={session}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          onSelectAnnotation={onSelectAnnotation}
          onRetry={handleRetry}
        />
      );
    }
    // whitelisted, channel-scoped reader handed to the extension (host API)
    const readChannel = (resource: string, params: Record<string, unknown>) => {
      if (!CHANNEL_READ_WHITELIST.has(resource)) {
        return Promise.reject(new Error(`resource not allowed: ${resource}`));
      }
      return ctx.sendResourceReq(resource, { ...params, channel_id: ctx.channelId });
    };
    return (
      <RendererErrorBoundary
        key={`${renderer.id}:${path}:${retryKey}`}
        renderer={renderer}
        path={path}
        session={session}
        annotations={annotations}
        activeAnnotationId={activeAnnotationId}
        onSelectAnnotation={onSelectAnnotation}
        onFailure={handleFailure}
        retryKey={retryKey}
        onRetry={handleRetry}
      >
        <SandboxRenderer
          key={`${renderer.id}:${path}:${retryKey}`}
          fs={ctx.fs}
          extension={extension}
          rendererId={renderer.rendererId ?? ""}
          path={path}
          channelId={ctx.channelId}
          readChannel={readChannel}
          onOpen={ctx.openLocator}
          onCompose={ctx.composeMessage}
          onFailure={(reason) => handleFailure(renderer.id, reason)}
          onAnnotate={annotations?.onAnnotate}
          onFormSubmit={onFormSubmit}
          inspectorActive={inspectorActive}
          active={ctx.active}
        />
      </RendererErrorBoundary>
    );
  }

  // built-in lens over this one file. Keyed by renderer+path (like the extension
  // branch) so switching file/renderer remounts it and lens-internal UI state (a
  // selection, a scroll offset, an expanded row) does not carry across.
  const lensId = renderer.lensId ?? "markdown";
  return (
    <RendererErrorBoundary
      key={`${renderer.id}:${path}:${retryKey}`}
      renderer={renderer}
      path={path}
      session={session}
      annotations={annotations}
      activeAnnotationId={activeAnnotationId}
      onSelectAnnotation={onSelectAnnotation}
      onFailure={handleFailure}
      retryKey={retryKey}
      onRetry={handleRetry}
    >
      {session ? (
        <LensView
          key={`${renderer.id}:${path}:${retryKey}`}
          session={session}
          lensId={lensId}
          config={config}
          channelId={ctx.channelId}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          onSelectAnnotation={onSelectAnnotation}
          onRevealSource={onRevealSource}
          openLocator={ctx.openLocator}
          inspectorActive={inspectorActive}
          onFormSubmit={onFormSubmit}
        />
      ) : (
        <LensPanel
          key={`${renderer.id}:${path}:${retryKey}`}
          fs={ctx.fs}
          path={path}
          lensId={lensId}
          config={config}
          channelId={ctx.channelId}
          reloadTick={ctx.filesTick}
          openLocator={ctx.openLocator}
          inspectorActive={inspectorActive}
          onFormSubmit={onFormSubmit}
        />
      )}
    </RendererErrorBoundary>
  );
}

