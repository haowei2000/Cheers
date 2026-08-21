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
              // The SOURCE decides, never the view — guardrail 3 in
              // docs/arch/PANEL_MODEL.md. `readOnly` removes the edit affordances
              // rather than leaving them inert: an Add row that silently does nothing
              // is worse than no Add row. Write-back for fs panels is not wired yet,
              // so onChange stays a no-op for now and the flag is what the user sees.
              readOnly: true,
              onChange: () => {},
            }),
        })
      );
    }
  }
}
