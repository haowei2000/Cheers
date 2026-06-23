// Typed fs.* wrappers over the channel WS resource client (`sendResourceReq`).
// Every workbench plugin reads/writes the channel workspace through this — there
// is no separate "memory" store; the workspace is just files (context_files),
// reached on demand (pull), authz'd by channel-role on the server.

export type SendResourceReq = (
  resource: string,
  params: Record<string, unknown>
) => Promise<unknown>;

export interface FsEntry {
  path: string;
  version: number;
  is_dir: boolean;
  size_bytes: number;
}

export interface FileContent {
  path: string;
  content: string;
  version: number;
  is_dir: boolean;
}

export function makeFsClient(send: SendResourceReq, channelId: string) {
  const ch = () => ({ channel_id: channelId });
  return {
    ls: (path = "") =>
      send("fs.ls", { ...ch(), path }) as Promise<{
        path: string;
        entries: FsEntry[];
      }>,
    read: (path: string) =>
      send("fs.read", { ...ch(), path }) as Promise<FileContent>,
    // `if_version` enforces the server's optimistic lock (0 = create-only).
    write: (path: string, content: string, ifVersion?: number) =>
      send("fs.write", {
        ...ch(),
        path,
        content,
        ...(ifVersion !== undefined ? { if_version: ifVersion } : {}),
      }) as Promise<{ path: string; version: number }>,
    // Destructive: server gates rm to owner/admin on the user path (PERMISSION_DENIED).
    rm: (path: string, recursive = false) =>
      send("fs.rm", { ...ch(), path, recursive }) as Promise<unknown>,
  };
}

export type FsClient = ReturnType<typeof makeFsClient>;
