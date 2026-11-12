import type { FsClient, SendResourceReq } from "../workbench/fsClient";

export interface Artifact {
  artifact_id: string;
  channel_id: string;
  uri: string;
  title: string;
  source_kind: "text" | "attachment";
  source_id: string;
  path: string | null;
  content_type: string | null;
  size_bytes: number;
  version: number;
  source_version: number;
  availability: "ready" | "pending" | "expired" | "deleted" | "failed";
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

/** The catalog filters by type on the gateway: the list is paged, so a filter applied to
 *  one loaded page would hide matches on the next. */
export type ArtifactListType = "canvas";

export interface ArtifactPage { artifacts: Artifact[]; next_cursor: string | null }
export interface ArtifactContent {
  uri?: string;
  artifact: Artifact;
  content?: string | null;
  kind: "text" | "binary" | "pending" | "unavailable";
  truncated: boolean;
  note?: string;
}

export function makeArtifactClient(send: SendResourceReq, channelId: string) {
  return {
    list: (before?: string, type?: ArtifactListType) => send("channel.artifacts.list", {
      channel_id: channelId, limit: 50, ...(before ? { before } : {}), ...(type ? { type } : {}),
    }) as Promise<ArtifactPage>,
    /** Create-only: an existing path is never overwritten. A retry with the same key
     *  returns the first result instead of failing on the path it already created. */
    create: (path: string, content: string, idempotencyKey: string) => send("channel.artifacts.create", {
      channel_id: channelId, path, content, idempotency_key: idempotencyKey,
    }) as Promise<{ artifact: Artifact }>,
    get: (artifactId: string) => send("channel.artifacts.get", {
      channel_id: channelId, artifact_id: artifactId,
    }) as Promise<Artifact>,
    resolve: (uri: string) => send("channel.artifacts.resolve", {
      channel_id: channelId, uri,
    }) as Promise<Artifact>,
    resolvePath: (path: string) => send("channel.artifacts.resolve", {
      channel_id: channelId, path,
    }) as Promise<Artifact>,
    read: (artifactId: string) => send("channel.artifacts.read", {
      channel_id: channelId, artifact_id: artifactId,
    }) as Promise<ArtifactContent>,
  };
}

export type ArtifactClient = ReturnType<typeof makeArtifactClient>;

const routed = new WeakMap<FsClient, Map<string, { client: FsClient; bound: Map<string, string> }>>();

/** The channel's file client with artifacts routed through the catalog: a bound path
 * reads, writes and patches by stable identity and artifact version. Configuration and
 * annotation files, and any path not bound, still belong to the provider workspace.
 *
 * There is ONE such client per base client and channel. File sessions and their drafts
 * are keyed by client identity, so every surface that opens the same artifact (the
 * library, a collection, a canvas) must get the same object or each would hold its own
 * buffer and version for one file. Binding is therefore additive, not a new client. */
export function artifactEditorClient(base: FsClient, send: SendResourceReq, channelId: string, artifact: Artifact): FsClient {
  let channels = routed.get(base);
  if (!channels) { channels = new Map(); routed.set(base, channels); }
  let route = channels.get(channelId);
  if (!route) {
    const bound = new Map<string, string>();
    const mutation = async (path: string, artifactId: string, verb: string, input: Record<string, unknown>) => {
      const result = await send(verb, { channel_id: channelId, artifact_id: artifactId, ...input }) as { artifact: Artifact };
      return { path: result.artifact.path ?? path, version: result.artifact.version, source_version: result.artifact.source_version };
    };
    route = { bound, client: {
      ...base,
      read: async (path) => {
        const artifactId = bound.get(path);
        if (!artifactId) return base.read(path);
        const result = await send("channel.artifacts.read", { channel_id: channelId, artifact_id: artifactId }) as ArtifactContent;
        if (result.kind !== "text" || result.truncated || typeof result.content !== "string") throw new Error("Full artifact source is unavailable");
        return { path: result.artifact.path ?? path, content: result.content, version: result.artifact.version, source_version: result.artifact.source_version, uri: result.uri, resource_id: result.artifact.source_id, is_dir: false };
      },
      write: (path, content, version) => {
        const artifactId = bound.get(path);
        return artifactId ? mutation(path, artifactId, "channel.artifacts.update", { content, if_version: version }) : base.write(path, content, version);
      },
      patch: (path, ops, version) => {
        const artifactId = bound.get(path);
        return artifactId ? mutation(path, artifactId, "channel.artifacts.patch", { ops, if_version: version }) : base.patch(path, ops, version);
      },
    } };
    channels.set(channelId, route);
  }
  if (artifact.path) {
    // A rename moves the artifact; a recreated file at this path is a different one.
    for (const [path, id] of route.bound) if (id === artifact.artifact_id && path !== artifact.path) route.bound.delete(path);
    route.bound.set(artifact.path, artifact.artifact_id);
  }
  return route.client;
}
