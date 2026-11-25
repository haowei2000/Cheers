import type { Artifact } from "../artifacts/client";

/** The catalog's answer for one canvas in one channel. `artifact: null` means the lookup
 *  failed and the canvas is open on its path instead. */
export interface CanvasLookup {
  key: string;
  artifact: Artifact | null;
}

export function canvasLookupKey(channelId: string, path: string): string {
  return `${channelId}\n${path}`;
}

/** Fold a lookup result into the settled state. The first answer for a key settles it,
 *  success or failure. A later answer replaces it only when the path now names a
 *  DIFFERENT artifact (deleted and recreated): a refresh of the same artifact, a late
 *  success after a fallback, or a transient failure must not swap the client out from
 *  under an open session. */
export function settleCanvasLookup(current: CanvasLookup | null, key: string, artifact: Artifact | null): CanvasLookup {
  if (current?.key !== key) return { key, artifact };
  if (!artifact || !current.artifact || current.artifact.artifact_id === artifact.artifact_id) return current;
  return { key, artifact };
}
