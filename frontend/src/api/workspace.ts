import { apiFetch, apiJson } from "./client";

/** A bot in the channel whose connector can serve a remote workspace. */
export interface WorkspaceBot {
  bot_id: string;
  username: string;
  display_name: string | null;
  online: boolean;
  /** False when the `workspace/read` policy hides this bot's workspace from the caller. */
  can_read: boolean;
  /** True only when the caller holds a write grant for this bot's workspace. */
  can_write: boolean;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
}

export interface WorkspaceTree {
  root: string;
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFile {
  root: string;
  path: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  is_text: boolean;
  content: string | null;
  content_b64: string;
  /** Content version (lowercase-hex SHA-256) used for optimistic-concurrency writes. */
  etag: string;
}

/**
 * A conditional write (`If-Match`) lost a race: the file on the bot's machine changed
 * since it was read. `currentEtag` is the server's current version (null if unknown);
 * `sizeBytes` is the current on-disk size. The caller decides: reload, or force-overwrite.
 */
export class WorkspaceConflictError extends Error {
  currentEtag: string | null;
  sizeBytes: number;
  constructor(currentEtag: string | null, sizeBytes: number) {
    super("workspace write conflict");
    this.name = "WorkspaceConflictError";
    this.currentEtag = currentEtag;
    this.sizeBytes = sizeBytes;
  }
}

/** Strip HTTP ETag decoration (weak `W/` prefix + surrounding quotes) to bare hex. */
function normalizeEtag(raw: string): string {
  return raw.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

/** Lowercase-hex SHA-256 of a UTF-8 string — the etag the server derives from bytes. */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pull {current_etag, size_bytes} out of a 409 body, tolerating several envelopes:
 * top-level, `.data`, or `.detail` (which may itself be a JSON-encoded string).
 */
function extractConflict(body: unknown): { currentEtag: string | null; sizeBytes: number } {
  const candidates: unknown[] = [];
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    candidates.push(o);
    if (o.data) candidates.push(o.data);
    if (typeof o.detail === "string") {
      try {
        candidates.push(JSON.parse(o.detail));
      } catch {
        /* detail is a plain message, not JSON */
      }
    } else if (o.detail) {
      candidates.push(o.detail);
    }
  }
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if ("current_etag" in o || "size_bytes" in o) {
        return {
          currentEtag: typeof o.current_etag === "string" ? o.current_etag : null,
          sizeBytes: typeof o.size_bytes === "number" ? o.size_bytes : 0,
        };
      }
    }
  }
  return { currentEtag: null, sizeBytes: 0 };
}

export async function listWorkspaceBots(channelId: string): Promise<WorkspaceBot[]> {
  const r = await apiJson<{ bots: WorkspaceBot[] }>(
    `/channels/${channelId}/workspace/bots`
  );
  return r.bots;
}

export async function getWorkspaceTree(
  channelId: string,
  botId: string,
  path = "",
  root?: string,
  sessionId?: string
): Promise<WorkspaceTree> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<WorkspaceTree>(`/channels/${channelId}/workspace/tree?${qs}`);
}

export async function getWorkspaceFile(
  channelId: string,
  botId: string,
  path: string,
  root?: string,
  sessionId?: string
): Promise<WorkspaceFile> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<WorkspaceFile>(`/channels/${channelId}/workspace/file?${qs}`);
}

/**
 * Write a text file back to the bot's machine, optionally guarded by `If-Match`:
 *   ifEtag === undefined → no header, unconditional overwrite;
 *   ifEtag === ""        → create-only (fail if the file already exists);
 *   ifEtag non-empty     → conditional (fail with 409 if the file has since changed).
 * Returns the file's NEW etag (from the response `ETag` header, else a self-derived
 * SHA-256 of the written bytes) so the caller can keep writing without re-reading.
 * Throws {@link WorkspaceConflictError} on a 409 (lost `If-Match` race).
 */
export async function putWorkspaceFile(
  channelId: string,
  botId: string,
  path: string,
  content: string,
  root?: string,
  sessionId?: string,
  ifEtag?: string
): Promise<string> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  const headers: Record<string, string> = {};
  if (ifEtag !== undefined) headers["If-Match"] = ifEtag;
  const res = await apiFetch(`/channels/${channelId}/workspace/file?${qs}`, {
    method: "PUT",
    body: content,
    headers,
  });
  if (res.status === 409) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON 409 body */
    }
    const { currentEtag, sizeBytes } = extractConflict(parsed);
    throw new WorkspaceConflictError(currentEtag, sizeBytes);
  }
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `HTTP ${res.status}`);
  const headerEtag = res.headers.get("ETag");
  return headerEtag ? normalizeEtag(headerEtag) : await sha256Hex(content);
}

/* ── Live-watch: ask the connector to signal us when files under a dir change ──
 * `watch` registers interest in the bot's `path` (under `root`, optionally scoped
 * to a session's root set); the connector then fans a `workspace_signal` browser
 * frame whenever the agent touches a file there. Registrations self-expire after
 * `ttl_secs` — the caller RENEWS by re-issuing `watch` on an interval under the
 * TTL, and best-effort `unwatch`es on close (the TTL reaps it either way).        */

export interface WorkspaceWatch {
  watch_id: string;
  ttl_secs: number;
}

export async function watchWorkspace(
  channelId: string,
  botId: string,
  path = "",
  root?: string,
  sessionId?: string
): Promise<WorkspaceWatch> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<WorkspaceWatch>(`/channels/${channelId}/workspace/watch?${qs}`, {
    method: "POST",
  });
}

export async function unwatchWorkspace(
  channelId: string,
  botId: string,
  watchId: string
): Promise<void> {
  const qs = new URLSearchParams({ bot_id: botId, watch_id: watchId });
  await apiFetch(`/channels/${channelId}/workspace/unwatch?${qs}`, { method: "POST" });
}

/* ── Read-only git visibility for the bot's remote working directory ──────────
 * These proxy to the connector's read-only git ops (`git status/diff/log`); they
 * never mutate the repo. On diff/log/show, a 409 means the path exists but isn't
 * a git repo, or the connector host has no `git`; a 403 means the connector
 * disabled git ops. `status` answers the non-repo case as data (`repo: false`)
 * instead of a 409 — it is re-polled on every live refresh, and a plain folder
 * is a normal thing to browse.                                                    */

/** One changed path from `git status --porcelain=v2` (best-effort parsed). */
export interface GitStatusEntry {
  /** Two-char porcelain code (e.g. `1 .M`'s `.M`, `??` untracked, `!!` ignored). */
  xy: string;
  path: string;
}

export interface GitStatus {
  /** Discriminant vs `GitStatusUnavailable` — absent (or true) ⇒ a real repo. */
  repo?: true;
  /** Raw `git status --porcelain=v2 --branch` stdout (authoritative). */
  raw: string;
  branch: string | null;
  /** Upstream ref (`# branch.upstream`, e.g. "origin/main") — what ahead/behind count against. */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: GitStatusEntry[];
}

/** `git/status` answer for a directory that is not inside a git repo (or whose
 *  connector host has no usable `git`) — a normal browse state, not an error. */
export interface GitStatusUnavailable {
  repo: false;
  /** The connector's typed reason, e.g. "E_NOT_A_REPO: not a git repository". */
  reason?: string;
}

export interface GitDiff {
  /** Unified diff text (`git diff --no-color`). */
  diff: string;
  staged: boolean;
}

export interface GitCommit {
  hash: string;
  author: string;
  /** ISO-8601 author date (`%aI`). */
  date: string;
  subject: string;
}

export interface GitLog {
  commits: GitCommit[];
}

export async function getGitStatus(
  channelId: string,
  botId: string,
  path = "",
  root?: string,
  sessionId?: string
): Promise<GitStatus | GitStatusUnavailable> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<GitStatus | GitStatusUnavailable>(
    `/channels/${channelId}/workspace/git/status?${qs}`
  );
}

export async function getGitDiff(
  channelId: string,
  botId: string,
  path = "",
  staged = false,
  root?: string,
  sessionId?: string
): Promise<GitDiff> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (staged) qs.set("staged", "true");
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<GitDiff>(`/channels/${channelId}/workspace/git/diff?${qs}`);
}

export async function getGitLog(
  channelId: string,
  botId: string,
  path = "",
  limit?: number,
  root?: string,
  sessionId?: string,
  skip?: number
): Promise<GitLog> {
  const qs = new URLSearchParams({ bot_id: botId, path });
  if (limit != null) qs.set("limit", String(limit));
  if (skip != null && skip > 0) qs.set("skip", String(skip));
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<GitLog>(`/channels/${channelId}/workspace/git/log?${qs}`);
}

export interface GitShow {
  commit: string;
  /** The `path` filter this diff was narrowed to, when one was given. */
  path?: string | null;
  /** Unified diff text of the commit (`git show --no-color <commit> [-- <path>]`). */
  diff: string;
}

/**
 * A single commit's diff (read-only). `commit` is a hash from getGitLog; `path`
 * (repo-root-relative, as listed by {@link getGitCommitFiles}) narrows the diff to
 * one file — it may reference a file that no longer exists in the working tree.
 */
export async function getGitShow(
  channelId: string,
  botId: string,
  commit: string,
  root?: string,
  sessionId?: string,
  path?: string
): Promise<GitShow> {
  const qs = new URLSearchParams({ bot_id: botId, commit });
  if (path) qs.set("path", path);
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<GitShow>(`/channels/${channelId}/workspace/git/show?${qs}`);
}

/** One changed file of a commit (`git show --name-status`). */
export interface GitCommitFile {
  /** Status letter(s): M / A / D, or R### / C### with a similarity score. */
  status: string;
  /** Repo-root-relative path (rename/copy → the destination). */
  path: string;
  /** Rename/copy source path. */
  old_path?: string | null;
}

export interface GitCommitFiles {
  commit: string;
  files: GitCommitFile[];
}

/** A commit's changed-file list (no diff bodies) — pair with getGitShow(path). */
export async function getGitCommitFiles(
  channelId: string,
  botId: string,
  commit: string,
  root?: string,
  sessionId?: string
): Promise<GitCommitFiles> {
  const qs = new URLSearchParams({ bot_id: botId, commit });
  if (root) qs.set("root", root);
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<GitCommitFiles>(
    `/channels/${channelId}/workspace/git/commit-files?${qs}`
  );
}

/* ── Workspace policy metadata (allowed roots / cwd / git availability) ──────── */

export interface WorkspaceMeta {
  /** The connector's hard clamp: every browse/read/write stays inside these. */
  allowed_roots: string[];
  /** The roots actually browsable in the current scope (session ∩ allowed). */
  effective_roots: string[];
  default_cwd: string | null;
  /** Whether the platform may pick a session cwd (connector policy). */
  backend_may_set_cwd: boolean;
  /** "read" (git inspection enabled) or "off". */
  git_ops: "read" | "off";
  max_read_bytes: number;
  max_write_bytes: number;
}

/** Describe the bot's workspace policy — backs the root picker & session dialogs. */
export async function getWorkspaceMeta(
  channelId: string,
  botId: string,
  sessionId?: string
): Promise<WorkspaceMeta> {
  const qs = new URLSearchParams({ bot_id: botId });
  if (sessionId) qs.set("session_id", sessionId);
  return apiJson<WorkspaceMeta>(`/channels/${channelId}/workspace/meta?${qs}`);
}

/** Where a clicked file reference actually lives (resolved by provenance, not syntax). */
export interface ResolvedRef {
  store: "inbox" | "desk" | "workspace" | "none";
  display_name: string;
  // inbox
  file_id?: string;
  content_type?: string | null;
  status?: string;
  // desk
  path?: string;
  content?: string | null;
  // workspace candidate
  bot_id?: string;
  also_in?: { store: string }[];
}

/**
 * Resolve a file reference clicked in a bot reply to the right store. Observational:
 * the gateway looks at what the bot actually produced in this channel; an unresolved
 * ref returns store:"none" (the UI then degrades gracefully — no 404).
 */
export async function resolveRef(
  channelId: string,
  ref: string,
  senderBotId?: string
): Promise<ResolvedRef> {
  return apiJson<ResolvedRef>(`/channels/${channelId}/resolve-ref`, {
    method: "POST",
    body: JSON.stringify({ ref, sender_bot_id: senderBotId }),
  });
}

/** Download arbitrary text content (e.g. a Desk file) as a file. */
export function downloadText(name: string, content: string, contentType = "text/plain"): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download from a fetched workspace file (text or base64 bytes). */
export function downloadWorkspaceFile(file: WorkspaceFile): void {
  let blob: Blob;
  if (file.is_text && file.content != null) {
    blob = new Blob([file.content], { type: file.content_type || "text/plain" });
  } else {
    const bin = atob(file.content_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: file.content_type || "application/octet-stream" });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  URL.revokeObjectURL(url);
}
