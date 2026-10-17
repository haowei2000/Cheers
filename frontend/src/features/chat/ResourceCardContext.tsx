import { createContext, useMemo, type ReactNode } from "react";
import type { FsClient } from "./workbench/fsClient";
import type { InteractionDispatcher, ResourceInteraction } from "./workbench/interaction";
import { createResourceInteractionDispatcher } from "./workbench/nativeResource";

export const ResourceCardContext = createContext<{
  fs: FsClient;
  channelId: string;
  interactions: InteractionDispatcher;
  filesTick: number;
} | null>(null);

export function ResourceCardProvider({ fs, channelId, filesTick = 0, openLocator, composeMessage, requestInteraction, children }: {
  fs: FsClient;
  channelId: string;
  filesTick: number;
  openLocator: (uri: string) => void;
  composeMessage: (text: string) => void;
  requestInteraction?: (event: ResourceInteraction) => Promise<{ msg_id: string }>;
  children: ReactNode;
}) {
  const interactions = useMemo(() => createResourceInteractionDispatcher({ fs, channelId, openLocator, composeMessage, requestInteraction }),
    [fs, channelId, openLocator, composeMessage, requestInteraction]);
  const value = useMemo(() => ({ fs, interactions, filesTick, channelId }), [fs, interactions, filesTick, channelId]);
  return <ResourceCardContext.Provider value={value}>{children}</ResourceCardContext.Provider>;
}
