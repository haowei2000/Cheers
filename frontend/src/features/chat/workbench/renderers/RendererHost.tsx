import type { WorkbenchContext } from "../context";
import type { ViewDef } from "../manifest";
import { LensPanel } from "../lens/LensPanel";
import { SandboxRenderer } from "../sandbox/SandboxRenderer";
import type { RendererDesc } from "./registry";
import { EXTENSION_CHANNEL_RESOURCES } from "../extensions/package";

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

// Mount the chosen renderer over one file. Built-in => the compiled lens (via a
// synthetic view); extension => the sandboxed render/save host. Both render exactly the
// one `path`; neither learns anything about how the other works.
export function RendererHost({
  ctx,
  path,
  renderer,
  config,
  onFailure,
}: {
  ctx: WorkbenchContext;
  path: string;
  renderer: RendererDesc;
  config?: unknown; // built-in lens config (e.g. table columns), from .workbench.json configs
  onFailure?: (rendererId: string, reason: string) => void;
}) {
  if (renderer.source === "extension") {
    const extension = ctx.rendererExtensions.find((p) => p.extensionId === renderer.extensionId);
    if (!extension) {
      return <div className="p-3 text-warning-400 text-compact">Renderer extension not installed: {renderer.extensionId}</div>;
    }
    // whitelisted, channel-scoped reader handed to the extension (host API)
    const readChannel = (resource: string, params: Record<string, unknown>) => {
      if (!CHANNEL_READ_WHITELIST.has(resource)) {
        return Promise.reject(new Error(`resource not allowed: ${resource}`));
      }
      return ctx.sendResourceReq(resource, { ...params, channel_id: ctx.channelId });
    };
    return (
      <SandboxRenderer
        // key by renderer+path so switching file/renderer remounts the iframe
        key={`${renderer.id}:${path}`}
        fs={ctx.fs}
        extension={extension}
        rendererId={renderer.rendererId ?? ""}
        path={path}
        readChannel={readChannel}
        onOpen={ctx.openLocator}
        onCompose={ctx.composeMessage}
        onFailure={(reason) => onFailure?.(renderer.id, reason)}
        active={ctx.active}
      />
    );
  }
  // built-in lens: a synthetic view feeds the LensPanel host (load → lens → save)
  const view: ViewDef = {
    id: `render:${renderer.id}:${path}`,
    title: renderer.title,
    file: path,
    lens: renderer.lensId ?? "markdown",
    config,
  };
  // key by renderer+path (like the extension branch) so switching file/renderer remounts
  // the LensPanel — a fresh instance resets its `dirty`/`seenTick` refs and useFile
  // state. Without this, a stale `dirty` carried over from an unsaved edit in another
  // file permanently gates live-push reload on a view-only lens (e.g. the metrics chart).
  return <LensPanel key={`${renderer.id}:${path}`} fs={ctx.fs} view={view} reloadTick={ctx.filesTick} />;
}
