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
    list: (before?: string) => send("channel.artifacts.list", {
      channel_id: channelId, limit: 50, ...(before ? { before } : {}),
    }) as Promise<ArtifactPage>,
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

/** Adapt the existing single-buffer editor to stable identity and artifact versions.
 * Configuration/annotation files still belong to the provider workspace. */
export function artifactEditorClient(base: FsClient, send: SendResourceReq, channelId: string, artifact: Artifact): FsClient {
  const params = { channel_id: channelId, artifact_id: artifact.artifact_id };
  const mutation = async (verb: string, input: Record<string, unknown>) => {
    const result = await send(verb, { ...params, ...input }) as { artifact: Artifact };
    return { path: result.artifact.path ?? artifact.path!, version: result.artifact.version, source_version: result.artifact.source_version };
  };
  return {
    ...base,
    read: async (path) => {
      if (path !== artifact.path) return base.read(path);
      const result = await send("channel.artifacts.read", params) as ArtifactContent;
      if (result.kind !== "text" || result.truncated || typeof result.content !== "string") throw new Error("Full artifact source is unavailable");
      return { path: result.artifact.path ?? path, content: result.content, version: result.artifact.version, source_version: result.artifact.source_version, uri: result.uri, resource_id: result.artifact.source_id, is_dir: false };
    },
    write: (path, content, version) => path !== artifact.path ? base.write(path, content, version)
      : mutation("channel.artifacts.update", { content, if_version: version }),
    patch: (path, ops, version) => path !== artifact.path ? base.patch(path, ops, version)
      : mutation("channel.artifacts.patch", { ops, if_version: version }),
  };
}
