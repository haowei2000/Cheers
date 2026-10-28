export type PresentationLevel = "minimal" | "medium" | "max";

export interface DeclaredAction {
  actionId: string;
  name: "cheers.request" | "cheers.compose" | "cheers.open" | "cheers.openNative" | "cheers.execute";
  botId?: string;
  uri?: string;
  opener?: string;
  payload: Record<string, unknown>;
  presentation: readonly PresentationLevel[];
  version: number;
}

export interface ResourceInteraction {
  v: 1;
  sourceUri: string;
  sourceVersion: number;
  surfaceId: string;
  componentId: string;
  actionId: string;
  botId: string;
  invocationId: string;
  input: Record<string, unknown>;
}

export type WorkbenchInteraction =
  | { kind: "open"; uri: string }
  | { kind: "compose"; actionId: string; formData: Record<string, unknown> }
  | { kind: "request"; event: ResourceInteraction }
  | {kind:"execute";event:ResourceInteraction}
  | { kind: "openNative"; uri: string; opener: string };

export type InteractionResult =
  | { ok: true; outcome: "executing" | "opened" | "drafted" | "requested" | "local" | "downloaded-copy"; messageId?: string; executionId?:string }
  | { ok: false; error: string };

export type InteractionDispatcher = ((intent: WorkbenchInteraction) => Promise<InteractionResult>) & {
  capabilities: readonly WorkbenchInteraction["kind"][];
};

export interface HostCapabilities {
  interactions: readonly WorkbenchInteraction["kind"][];
  canDesignEdit: boolean;
  canWrite: boolean;
}

export interface ResourceViewStateStore {
  getDraft: (key: string) => unknown;
  setDraft: (key: string, value: unknown) => void;
}

/** Unified view host interface across inline reply previews, expand modals, and Workbench. */
export interface ResourceViewHost {
  uri: string;
  version: number;
  presentation: PresentationLevel;
  capabilities: HostCapabilities;
  interactions: InteractionDispatcher;
  readOnly: boolean;
  state?: ResourceViewStateStore;
  openLocator?: (uri: string) => void | Promise<void>;
  fs?: unknown;
}
