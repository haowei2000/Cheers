import type {
  InteractionDispatcher,
  PresentationLevel,
  ResourceViewHost,
  ResourceViewStateStore,
} from "./types.ts";

export function createReplyViewHost(params: {
  uri: string;
  version: number;
  expanded: boolean;
  interactions: InteractionDispatcher;
  fs?: unknown;
  readOnly?: boolean;
  state?: ResourceViewStateStore;
  openLocator?: (uri: string) => void | Promise<void>;
}): ResourceViewHost {
  const readOnly = params.readOnly ?? !params.interactions.capabilities.includes("request");
  return {
    uri: params.uri,
    version: params.version,
    presentation: params.expanded ? "medium" : "minimal",
    capabilities: {
      interactions: params.interactions.capabilities,
      canDesignEdit: false, // Reply views never allow arbitrary canvas design/drag mutations
      canWrite: !readOnly,
    },
    interactions: params.interactions,
    readOnly,
    state: params.state,
    openLocator: params.openLocator,
    fs: params.fs,
  };
}

export function createWorkbenchViewHost(params: {
  uri: string;
  version: number;
  presentation?: PresentationLevel;
  interactions: InteractionDispatcher;
  readOnly?: boolean;
  inspectorActive?: boolean;
  state?: ResourceViewStateStore;
  openLocator?: (uri: string) => void | Promise<void>;
  fs?: unknown;
}): ResourceViewHost {
  const readOnly = Boolean(params.readOnly);
  return {
    uri: params.uri,
    version: params.version,
    presentation: params.presentation ?? "max",
    capabilities: {
      interactions: params.interactions.capabilities,
      canDesignEdit: !readOnly && Boolean(params.inspectorActive),
      canWrite: !readOnly,
    },
    interactions: params.interactions,
    readOnly,
    state: params.state,
    openLocator: params.openLocator,
    fs: params.fs,
  };
}
