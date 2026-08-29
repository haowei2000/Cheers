import { apiJson } from "@/api/client";
import type { PanelDef, TemplateManifest } from "../manifest";
import {
  type AutomationContribution,
  type ExtensionManifest,
  type ExtensionPermissions,
  type PanelContribution,
  type RendererContribution,
  type SceneContribution,
} from "./package";

export interface ExtensionSummary {
  id: string;
  version: string;
  title: string;
  description: string;
  sha256: string;
  origin: "system";
  scenes: SceneContribution[];
  renderers: RendererContribution[];
  automations: AutomationContribution[];
  /** Declarative lane panels (Tier A). Absent on a gateway older than the panels
   *  contribution, hence optional. */
  panels?: PanelContribution[];
  permissions: ExtensionPermissions;
  updatedAt: string;
}

interface ResolvedScene {
  id: string;
  title: string;
  items: PanelDef[];
  seed: Array<{ path: string; content: string }>;
  pin: string[];
}

export function listExtensions(): Promise<ExtensionSummary[]> {
  return apiJson<ExtensionSummary[]>("/workbench/extensions");
}

export async function listOfficialScenes(): Promise<TemplateManifest[]> {
  const extensions = await listExtensions();
  return Promise.all(
    extensions.flatMap((extension) =>
      extension.scenes.map(async (scene) => {
        const resolved = await apiJson<ResolvedScene>(
          `/workbench/extensions/${encodeURIComponent(extension.id)}/scenes/${encodeURIComponent(scene.id)}`
        );
        return {
          id: `extension:${extension.id}:${scene.id}`,
          title: resolved.title,
          items: resolved.items,
          seed: Object.fromEntries(resolved.seed.map((file) => [file.path, file.content])),
          pin: resolved.pin,
        } satisfies TemplateManifest;
      })
    )
  );
}
