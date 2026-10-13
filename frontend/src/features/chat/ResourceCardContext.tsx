import { createContext, useMemo, type ReactNode } from "react";
import type { FsClient } from "./workbench/fsClient";
import type { InteractionDispatcher, ResourceInteraction } from "./workbench/interaction";
import { createResourceInteractionDispatcher } from "./workbench/nativeResource";

export const ResourceCardContext = createContext<{
  fs: FsClient;
  interactions: InteractionDispatcher;
  filesTick: number;
} | null>(null);

export function ResourceCardProvider({ fs, channelId, filesTick, openLocator, composeMessage, requestInteraction, children }: {
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
  const value = useMemo(() => ({ fs, interactions, filesTick }), [fs, interactions, filesTick]);
  return <ResourceCardContext.Provider value={value}>{children}</ResourceCardContext.Provider>;
}
