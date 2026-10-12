import { parseLocator, validInspectableId } from "../locator";

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
  | { kind: "openNative"; uri: string; opener: string };
export type InteractionResult =
  | { ok: true; outcome: "opened" | "drafted" | "requested" | "local" | "downloaded-copy"; messageId?: string }
  | { ok: false; error: string };
export type InteractionDispatcher = ((intent: WorkbenchInteraction) => Promise<InteractionResult>) & {
  capabilities: readonly WorkbenchInteraction["kind"][];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
function jsonInputs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Form inputs must be an object.");
  const serialized = JSON.stringify(input);
  if (serialized.length > 20_000) throw new Error("Form inputs are too large.");
  return JSON.parse(serialized) as Record<string, unknown>;
}

/** One asynchronous host boundary; gateway and native executors recheck authority. */
export function createInteractionDispatcher(host: {
  openLocator?: (uri: string) => void | Promise<void>;
  composeMessage?: (text: string) => void;
  onFormSubmit?: (data: { actionId: string; formData: Record<string, unknown> }) => void;
  requestInteraction?: (event: ResourceInteraction) => Promise<{ msg_id: string }>;
  openNative?: (uri: string, opener: string) => Promise<"local" | "downloaded-copy">;
}): InteractionDispatcher {
  const capabilities: WorkbenchInteraction["kind"][] = [];
  if (host.openLocator) capabilities.push("open");
  if (host.composeMessage || host.onFormSubmit) capabilities.push("compose");
  if (host.requestInteraction) capabilities.push("request");
  if (host.openNative) capabilities.push("openNative");
  const dispatch = async (intent: WorkbenchInteraction): Promise<InteractionResult> => {
    try {
      if (!capabilities.includes(intent.kind)) throw new Error("This interaction is unavailable in this view.");
      if (intent.kind === "open" || intent.kind === "openNative") {
        if (!parseLocator(intent.uri)) throw new Error("This resource link is not supported.");
        if (intent.kind === "openNative") {
          if (!["finder", "vscode", "zed"].includes(intent.opener)) throw new Error("This application is not supported.");
          return { ok: true, outcome: await host.openNative!(intent.uri, intent.opener) };
        }
        await host.openLocator!(intent.uri);
        return { ok: true, outcome: "opened" };
      }
      if (intent.kind === "request") {
        const event = intent.event;
        if (parseLocator(event.sourceUri)?.kind !== "desk" || event.v !== 1 ||
          !Number.isSafeInteger(event.sourceVersion) || event.sourceVersion < 1 ||
          !validInspectableId(event.surfaceId) || !validInspectableId(event.componentId) ||
          !ACTION_ID.test(event.actionId) || !UUID.test(event.botId) || !UUID.test(event.invocationId)) {
          throw new Error("The resource interaction context is invalid.");
        }
        const result = await host.requestInteraction!({ ...event, input: jsonInputs(event.input) });
        return { ok: true, outcome: "requested", messageId: result.msg_id };
      }
      if (!ACTION_ID.test(intent.actionId)) throw new Error("The action identifier is invalid.");
      const formData = jsonInputs(intent.formData);
      if (host.onFormSubmit) host.onFormSubmit({ actionId: intent.actionId, formData });
      else {
        const summary = Object.entries(formData).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ");
        host.composeMessage!(`[Action ${intent.actionId}] ${summary}`);
      }
      return { ok: true, outcome: "drafted" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The interaction could not be completed. Try again." };
    }
  };
  return Object.assign(dispatch, { capabilities });
}
