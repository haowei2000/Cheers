import { createContext, useMemo, type ReactNode } from "react";
import type { FsClient } from "./workbench/fsClient";
import type { InteractionDispatcher, ResourceInteraction } from "./workbench/interaction";
import { createResourceInteractionDispatcher } from "./workbench/nativeResource";
import type { SendResourceReq } from "./workbench/fsClient";
import { artifactReferenceStore, type ArtifactReferenceStore } from "./artifacts/referenceStore";
import { useArtifactInvalidation } from "./artifacts/useArtifactReference";

export const ResourceCardContext = createContext<{
  fs: FsClient;
  channelId: string;
  interactions: InteractionDispatcher;
  filesTick: number;
  /** Absent where the host has no channel resource transport: artifact links then keep
   *  their plain entry instead of a preview. */
  artifactRefs?: ArtifactReferenceStore;
} | null>(null);

export function ResourceCardProvider({ fs, channelId, filesTick = 0, sendResourceReq, openLocator, composeMessage, requestInteraction, children }: {
  fs: FsClient;
  channelId: string;
  filesTick: number;
  sendResourceReq?: SendResourceReq;
  openLocator: (uri: string) => void;
  composeMessage: (text: string) => void;
  requestInteraction?: (event: ResourceInteraction) => Promise<{ msg_id: string }>;
  children: ReactNode;
}) {
  const interactions = useMemo(() => createResourceInteractionDispatcher({ fs, channelId, openLocator, composeMessage, requestInteraction }),
    [fs, channelId, openLocator, composeMessage, requestInteraction]);
  const artifactRefs = sendResourceReq ? artifactReferenceStore(sendResourceReq, channelId) : undefined;
  useArtifactInvalidation(artifactRefs, filesTick);
  const value = useMemo(() => ({ fs, interactions, filesTick, channelId, artifactRefs }), [fs, interactions, filesTick, channelId, artifactRefs]);
  return <ResourceCardContext.Provider value={value}>{children}</ResourceCardContext.Provider>;
}
