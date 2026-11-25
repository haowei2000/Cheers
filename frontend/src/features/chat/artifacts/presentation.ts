import { builtinView, VIEW_SUFFIXES } from "../workbench/renderers/registry";
import type { Artifact } from "./client";

// How an artifact is named in chrome. Shared by the library and by canvas cards that
// reference an artifact, so the two never describe the same artifact differently.

export const availabilityLabel: Record<Artifact["availability"], string> = {
  ready: "Ready", pending: "Preparing", expired: "Expired", deleted: "Deleted", failed: "Failed",
};

export function artifactType(artifact: Pick<Artifact, "title" | "content_type">): string {
  const view = builtinView(artifact.title);
  return VIEW_SUFFIXES.find((row) => row.view === view)?.title ?? "File";
}
