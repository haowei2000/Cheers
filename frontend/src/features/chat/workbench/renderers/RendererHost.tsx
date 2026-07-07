import type { WorkbenchContext } from "../context";
import type { ViewDef } from "../manifest";
import { LensPanel } from "../lens/LensPanel";
import { SandboxRenderer } from "../sandbox/SandboxRenderer";
import type { RendererDesc } from "./registry";

// The channel.* read verbs a renderer plugin may call (host API). READ-ONLY and low/medium
// sensitivity. NOTE: a sandboxed iframe is isolated for tokens/DOM but NOT for network — a
// plugin could exfiltrate whatever it's handed. Plugins are admin-installed (the admin
// vouches for them) and every read still passes server-side channel-role authz as the user,
// scoped to THIS channel (channel_id is forced below). Keep this list conservative.
const CHANNEL_READ_WHITELIST = new Set([
  "channel.info",
  "channel.members",
  "channel.messages",
  "channel.activity.read",
  "channel.messages.index",
]);

// Mount the chosen renderer over one file. Built-in => the compiled lens (via a
// synthetic view); plugin => the sandboxed render/save host. Both render exactly the
// one `path`; neither learns anything about how the other works.
export function RendererHost({
  ctx,
  path,
  renderer,
  config,
}: {
  ctx: WorkbenchContext;
  path: string;
  renderer: RendererDesc;
  config?: unknown; // built-in lens config (e.g. table columns), from .workbench.json configs
}) {
  if (renderer.source === "plugin") {
    const plugin = ctx.plugins.find((p) => p.plugin_id === renderer.pluginId);
    if (!plugin) {
      return <div className="p-3 text-amber-500 text-xs">Renderer plugin not installed: {renderer.pluginId}</div>;
    }
    // whitelisted, channel-scoped reader handed to the plugin (host API)
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
        plugin={plugin}
        rendererId={renderer.rendererId ?? ""}
        path={path}
        readChannel={readChannel}
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
  // key by renderer+path (like the plugin branch) so switching file/renderer remounts
  // the LensPanel — a fresh instance resets its `dirty`/`seenTick` refs and useFile
  // state. Without this, a stale `dirty` carried over from an unsaved edit in another
  // file permanently gates live-push reload on a view-only lens (e.g. the metrics chart).
  return <LensPanel key={`${renderer.id}:${path}`} fs={ctx.fs} view={view} reloadTick={ctx.filesTick} />;
}
