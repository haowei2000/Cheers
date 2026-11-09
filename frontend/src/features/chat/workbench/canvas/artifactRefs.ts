import type { Artifact } from "../../artifacts/client";
import { artifactType, availabilityLabel } from "../../artifacts/presentation";
import { nodeTitle, type CanvasNode } from "./document";

/** What the catalog said about a referenced artifact. "missing" covers both an id the
 *  channel does not have and one this viewer may not read — the card must not say which. */
export type ArtifactRef = Artifact | "missing";

/** The catalog title wins once it is known: it follows renames, the node id does not. */
export function artifactNodeTitle(node: CanvasNode, ref: ArtifactRef | undefined): string {
  return ref && ref !== "missing" ? ref.title : nodeTitle(node);
}

/** The card's second line: what the artifact is, or why it cannot be opened. Before the
 *  catalog answers, the id is the only thing the canvas file knows. */
export function artifactNodeDetail(artifactId: string, ref: ArtifactRef | undefined): string {
  if (ref === undefined) return artifactId;
  if (ref === "missing") return "Unavailable";
  return ref.availability === "ready" ? artifactType(ref) : availabilityLabel[ref.availability];
}
