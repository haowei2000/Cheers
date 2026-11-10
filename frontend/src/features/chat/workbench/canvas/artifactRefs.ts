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

/** Only a ready text artifact has a source the card can quote. An attachment may be a
 *  multi-megabyte binary, and a deleted or pending one has nothing current to show. */
export function hasTextExcerpt(ref: ArtifactRef | undefined): ref is Artifact {
  return ref !== undefined && ref !== "missing" && ref.availability === "ready" && ref.source_kind === "text";
}

const EXCERPT_LINES = 6;
const EXCERPT_LINE_CHARS = 160;

/** The opening lines of an artifact's source, as the card quotes them. Leading blank
 *  lines are dropped so the card does not open on whitespace; long lines are cut so one
 *  minified line cannot stand in for the whole file. */
export function artifactExcerpt(content: string): string {
  const lines = content.replace(/^\s*\n/, "").split("\n");
  const shown = lines.slice(0, EXCERPT_LINES).map((line) =>
    line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS)}…` : line);
  return (lines.length > EXCERPT_LINES ? [...shown, "…"] : shown).join("\n").trimEnd();
}
