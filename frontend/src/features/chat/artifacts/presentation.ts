import { formatOf } from "../workbench/renderers/registry";
import type { Artifact } from "./client";

// How an artifact is named in chrome. Shared by the library and by canvas cards that
// reference an artifact, so the two never describe the same artifact differently.

export const availabilityLabel: Record<Artifact["availability"], string> = {
  ready: "Ready", pending: "Preparing", expired: "Expired", deleted: "Deleted", failed: "Failed",
};

export function artifactType(artifact: Pick<Artifact, "title" | "content_type">): string {
  const format = formatOf(artifact.title);
  if (format === "html" || format === "react") return "Interactive page";
  if (/\.canvas\.(json|ya?ml)$/i.test(artifact.title)) return "Canvas";
  if (format === "markdown") return "Document";
  if (artifact.content_type?.startsWith("image/")) return "Image";
  if (artifact.content_type === "application/pdf") return "PDF";
  return "File";
}
