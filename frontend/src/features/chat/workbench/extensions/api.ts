import { apiFetch, apiJson } from "@/api/client";
import type { TemplateManifest } from "../manifest";
import {
  EXTENSION_MEDIA_TYPE,
  type ExtensionManifest,
  type ExtensionPermissions,
  type RendererContribution,
  type SceneContribution,
} from "./package";

export interface ExtensionSummary {
  id: string;
  version: string;
  title: string;
  description: string;
  sha256: string;
  origin: "admin" | "system";
  scenes: SceneContribution[];
  renderers: RendererContribution[];
  permissions: ExtensionPermissions;
  updatedAt: string;
}

interface ResolvedScene {
  id: string;
  title: string;
  items: Array<{ id: string; title: string; file: string; renderer: string; config?: unknown }>;
  seed: Array<{ path: string; content: string }>;
  pin: string[];
}

export function listExtensions(): Promise<ExtensionSummary[]> {
  return apiJson<ExtensionSummary[]>("/workbench/extensions");
}

export async function listGlobalScenes(): Promise<TemplateManifest[]> {
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
          views: resolved.items.map((item) => ({
            ...item,
            lens: item.renderer.startsWith("builtin:") ? item.renderer.slice(8) : "markdown",
          })),
          seed: Object.fromEntries(resolved.seed.map((file) => [file.path, file.content])),
          pin: resolved.pin,
        } satisfies TemplateManifest;
      })
    )
  );
}

export async function installGlobalExtension(manifest: ExtensionManifest, bytes: Uint8Array): Promise<void> {
  const res = await apiFetch(`/workbench/extensions/${encodeURIComponent(manifest.id)}`, {
    method: "PUT",
    headers: { "Content-Type": EXTENSION_MEDIA_TYPE },
    body: new Blob([new Uint8Array(bytes)], { type: EXTENSION_MEDIA_TYPE }),
  });
  if (!res.ok) throw new Error(`install ${res.status}: ${await res.text()}`);
}

export async function deleteExtension(id: string): Promise<void> {
  const res = await apiFetch(`/workbench/extensions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete ${res.status}: ${await res.text()}`);
}
