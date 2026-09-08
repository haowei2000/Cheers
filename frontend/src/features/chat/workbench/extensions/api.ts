import { apiJson } from "@/api/client";
import type { PanelDef, TemplateManifest } from "../manifest";
import {
  type AutomationContribution,
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

export interface ResolvedSceneItem {
  id: string;
  title: string;
  /** Published v1 fields, retained by the gateway for released clients. */
  file?: string;
  renderer?: string;
  /** Normalized fields emitted for current clients. */
  source?: { kind: "fs"; path: string };
  view?: string;
  config?: unknown;
}

interface ResolvedScene {
  id: string;
  title: string;
  items: ResolvedSceneItem[];
  seed: Array<{ path: string; content: string }>;
  pin: string[];
}

/** Accept both sides of the rolling-deploy window. New gateways emit both; older
 * gateways emit only file/renderer. */
export function normalizeResolvedSceneItem(item: ResolvedSceneItem): PanelDef {
  const path = item.source?.kind === "fs" ? item.source.path : item.file;
  if (!path) throw new Error(`Scene item ${item.id} has no file path`);
  return {
    id: item.id,
    title: item.title,
    source: { kind: "fs", path },
    view: item.view ?? item.renderer ?? "auto",
    config: item.config,
  };
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
          items: resolved.items.map(normalizeResolvedSceneItem),
          seed: Object.fromEntries(resolved.seed.map((file) => [file.path, file.content])),
          pin: resolved.pin,
        } satisfies TemplateManifest;
      })
    )
  );
}
