import type { ArtifactReference } from "../../artifacts/referenceStore";
import { artifactType, availabilityLabel } from "../../artifacts/presentation";
import { nodeTitle, type CanvasNode } from "./document";

/** The catalog title wins once it is known: it follows renames, the node id does not. */
export function artifactNodeTitle(node: CanvasNode, ref: ArtifactReference | undefined): string {
  return ref?.artifact?.title ?? nodeTitle(node);
}

/** The card's second line: what the artifact is, or why it cannot be opened. Before the
 *  catalog answers, the id is the only thing the canvas file knows. */
export function artifactNodeDetail(artifactId: string, ref: ArtifactReference | undefined): string {
  if (ref?.missing) return "Unavailable";
  const artifact = ref?.artifact;
  if (!artifact) return artifactId;
  return artifact.availability === "ready" ? artifactType(artifact) : availabilityLabel[artifact.availability];
}

const EXCERPT_LINES = 6;
const EXCERPT_LINE_CHARS = 160;

/** The opening lines of an artifact's source, as the card quotes them. Leading and
 *  trailing blank lines are dropped, so the card does not open on whitespace and a final
 *  newline is not counted as omitted text; long lines are cut so one minified line cannot
 *  stand in for the whole file. */
export function artifactExcerpt(content: string): string {
  const lines = content.replace(/^\s*\n/, "").trimEnd().split("\n");
  const shown = lines.slice(0, EXCERPT_LINES).map((line) =>
    line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS)}…` : line);
  return (lines.length > EXCERPT_LINES ? [...shown, "…"] : shown).join("\n").trimEnd();
}
