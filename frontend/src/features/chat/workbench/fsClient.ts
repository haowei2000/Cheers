// Typed fs.* wrappers over the channel WS resource client (`sendResourceReq`).
// Every Workbench renderer reads/writes the channel workspace through this — there
// is no separate "memory" store; the workspace is just files (context_files),
// reached on demand (pull), authz'd by channel-role on the server.

import type { PatchOp } from "./patchOps";

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
    // Structured edits, applied atomically under the same optimistic lock. Preferred
    // over `write` for machine-edited documents: it preserves YAML comments that a
    // whole-document rewrite loses whenever an array's LENGTH changes, and a rejected
    // op batch can be replayed against the newer version — a stale document cannot.
    // See patchOps.ts.
    patch: (path: string, ops: readonly PatchOp[], ifVersion: number) =>
      send("fs.patch", { ...ch(), path, ops, if_version: ifVersion }) as Promise<{
        path: string;
        version: number;
      }>,
    // Destructive: server gates rm to owner/admin on the user path (PERMISSION_DENIED).
    rm: (path: string, recursive = false) =>
      send("fs.rm", { ...ch(), path, recursive }) as Promise<unknown>,
  };
}

export type FsClient = ReturnType<typeof makeFsClient>;
