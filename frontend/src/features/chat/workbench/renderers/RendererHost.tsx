import type { PanelContext } from "../panelRegistry";
import type { ViewDef } from "../manifest";
import { viewToPanel } from "../lens/LensPanel";
import { SandboxRenderer } from "../sandbox/SandboxRenderer";
import type { RendererDesc } from "./registry";

// Mount the chosen renderer over one file. Built-in => reuse the compiled lens (via a
// synthetic view); plugin => the sandboxed render/save host. Both render exactly the
// one `path`; neither learns anything about how the other works.
export function RendererHost({
  ctx,
  path,
  renderer,
}: {
  ctx: PanelContext;
  path: string;
  renderer: RendererDesc;
}) {
  if (renderer.source === "plugin") {
    const plugin = ctx.plugins.find((p) => p.plugin_id === renderer.pluginId);
    if (!plugin) {
      return <div className="p-3 text-amber-500 text-xs">渲染器插件未安装：{renderer.pluginId}</div>;
    }
    return (
      <SandboxRenderer
        // key by renderer+path so switching file/renderer remounts the iframe
        key={`${renderer.id}:${path}`}
        fs={ctx.fs}
        plugin={plugin}
        rendererId={renderer.rendererId ?? ""}
        path={path}
      />
    );
  }
  // built-in lens: a synthetic view feeds the existing LensPanel (load → lens → save).
  const view: ViewDef = {
    id: `render:${renderer.id}:${path}`,
    title: renderer.title,
    file: path,
    lens: renderer.lensId ?? "markdown",
  };
  return <>{viewToPanel(view).render(ctx)}</>;
}
