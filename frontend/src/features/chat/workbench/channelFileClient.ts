import { clientSessionGeneration } from "@/lib/clientSession";
import { ResourceError } from "../hooks/useChatRealtime";
import { fileResourceStore } from "./fileResource";
import { makeFsClient, type FsClient, type SendResourceReq } from "./fsClient";
import { parseLocator } from "../locator";
import { resolveDeskResource } from "@/api/resources";

const MAX_IDLE_CHANNELS = 30;
const clients = new WeakMap<SendResourceReq, { generation: number; channels: Map<string, FsClient> }>();

/** Navigation reuses the authorized channel client, so resource sessions have a
 * stable identity across A → B → A. Cache only this authentication generation;
 * retain dirty/subscribed resources and evict inactive channel clients first. */
export function channelFileClient(send: SendResourceReq, channelId: string): FsClient {
  const generation = clientSessionGeneration();
  let scope = clients.get(send);
  if (!scope || scope.generation !== generation) {
    scope = { generation, channels: new Map() };
    clients.set(send, scope);
  }
  let client = scope.channels.get(channelId);
  if (!client) {
    client = makeFsClient((resource, params) => {
      if (generation !== clientSessionGeneration()) return Promise.reject(new ResourceError("DISCONNECTED", "Your session changed. Reopen this resource."));
      return send(resource, params);
    }, channelId);
  }
  scope.channels.delete(channelId);
  scope.channels.set(channelId, client);
  if (scope.channels.size > MAX_IDLE_CHANNELS) for (const [key, value] of scope.channels) {
    if (key !== channelId && !fileResourceStore(value).active()) scope.channels.delete(key);
    if (scope.channels.size <= MAX_IDLE_CHANNELS) break;
  }
  return client;
}

/** A global locator can name another channel even when its path is identical.
 * Resolve identity before turning the URI into a channel-local file selection. */
export async function resolveWorkbenchTarget(uri: string, channelId: string) {
  const generation = clientSessionGeneration();
  const resource = await resolveDeskResource(uri, channelId);
  if (generation !== clientSessionGeneration()) throw new ResourceError("DISCONNECTED", "Your session changed. Reopen this resource.");
  if (resource.channel_id !== channelId) throw new ResourceError("CHANNEL_MISMATCH", "This resource belongs to another channel. Open it from that channel.");
  return resource;
}

/** A current resource URI is navigation to the canonical channel resource.
 * Only immutable historical revisions need a distinct, read-only transport. */
export function workbenchFileClient(send: SendResourceReq, channelId: string, target?: string, shared?: FsClient): FsClient {
  const locator = target ? parseLocator(target) : null;
  const current = shared ?? channelFileClient(send, channelId);
  if (locator?.kind !== "resource" || locator.resourceKind !== "desk" || locator.version === undefined) return current;
  const generation = clientSessionGeneration();
  return makeFsClient(async (verb, params) => {
    if (generation !== clientSessionGeneration()) throw new ResourceError("DISCONNECTED", "Your session changed. Reopen this resource.");
    if (verb !== "fs.read" && verb !== "fs.ls") throw new Error("Historical resource revisions are read-only. Open the current URI to edit.");
    if (verb === "fs.read") {
      const resource = await resolveWorkbenchTarget(target!, channelId);
      if (generation !== clientSessionGeneration()) throw new ResourceError("DISCONNECTED", "Your session changed. Reopen this resource.");
      if (params.path === resource.path) return resource;
    }
    return send(verb, params);
  }, channelId);
}
