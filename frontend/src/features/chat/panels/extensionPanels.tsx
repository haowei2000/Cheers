import { LayoutGrid } from "lucide-react";
import { getLens } from "@/features/chat/workbench/lens/registry";
import "@/features/chat/workbench/lens/builtins"; // side effect: register builtin lenses
import type { ExtensionSummary } from "@/features/chat/workbench/extensions/api";
import type { PanelContribution as ManifestPanel } from "@/features/chat/workbench/extensions/package";
import { registerPanel } from "./registry";
import { defineDataPanel } from "./definePanel";
import type { PanelSource } from "./source";

// Turn a package's declarative panel contributions into registered lane panels.
//
// This is Tier A of the plugin model (docs/arch/PLUGIN_SYSTEM.md): a panel that names
// an allowlisted source and a compiled built-in view is pure data, so it carries no new
// security surface and installs at global scope. The installers have already rejected
// anything else by the time this runs — it does not re-validate, it renders.

/** Stable id, matching the scene convention: `extension:<extension-id>:<panel-id>`. */
export function extensionPanelId(extensionId: string, panelId: string): string {
  return `extension:${extensionId}:${panelId}`;
}

function sourceOf(panel: ManifestPanel): PanelSource {
  return panel.source.kind === "resource"
    ? { kind: "resource", verb: panel.source.verb }
    : { kind: "fs", path: panel.source.path };
}

/** The compiled view a `builtin:<id>` reference names, or null if it does not resolve.
 *  `self:` views are personal-scope renderer code and are not handled here. */
function lensIdOf(view: string): string | null {
  return view.startsWith("builtin:") ? view.slice(8) : null;
}

export function registerExtensionPanels(extensions: ExtensionSummary[]): void {
  for (const extension of extensions) {
    for (const panel of extension.panels ?? []) {
      const lensId = lensIdOf(panel.view);
      const lens = lensId ? getLens(lensId) : undefined;
      if (!lens) continue; // an unresolvable view renders nothing rather than throwing
      const source = sourceOf(panel);
      registerPanel(
        defineDataPanel({
          id: extensionPanelId(extension.id, panel.id),
          title: panel.title,
          icon: LayoutGrid,
          source,
          render: (data) =>
            lens.render({
              data,
              config: undefined,
              // READ-ONLY, whatever the view would allow. Guardrail 3 in
              // docs/arch/PANEL_MODEL.md: writability belongs to the SOURCE, not the
              // view. A resource source is a projection with no version to write back
              // against, so a Save here would overwrite a concurrent agent write with a
              // stale snapshot. Write-back for `fs` panels is deliberately not wired
              // yet; when it is, it branches on the source and never on the lens.
              onChange: () => {},
            }),
        })
      );
    }
  }
}
