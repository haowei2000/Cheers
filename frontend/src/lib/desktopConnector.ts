// Frontend wrappers for the desktop-shell **connector** Tauri commands (the
// γ-connector contract: live changed-files watch, git status/diff/revert,
// drag-to-grant roots, audit timeline, health sampling, agent updates).
//
// These are kept OUT of lib/desktop.ts on purpose: that file is the generic
// desktop bridge, this one is the connector feature surface. Everything here is
// a thin call through invokeDesktop and is only valid inside the desktop shell —
// callers already live under ConnectorManager, which is Tauri-only.
//
// The types below mirror the Rust serde structs EXACTLY (changes.rs / audit.rs /
// connector.rs in the desktop crate) — field names and shapes are the wire
// contract, so they must not drift.

import { invokeDesktop } from "@/lib/desktop";
import { isTauri } from "@/lib/serverConfig";

// ── Shared types (mirror the Rust serde structs) ──

/** One changed path in a git working tree (`status` = porcelain XY code). */
export interface FileStatus {
  path: string;
  status: string;
}

/** `connector_git_status` result — git state of a connector's workdir. */
export interface GitStatus {
  is_repo: boolean;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  files: FileStatus[];
}

/** One entry in the FSEvents batch — path relative to the workdir + coarse kind. */
export interface ChangedFile {
  path: string;
  /** "create" | "modify" | "remove" | "other". */
  kind: string;
}

/** Payload of the debounced `connector-changes` FSEvents watch event. */
export interface ChangesPayload {
  name: string;
  files: ChangedFile[];
  /** Recomputed each batch; null when the workdir isn't a git repo. */
  git: GitStatus | null;
}

/** One row of the read-only audit timeline (`connector_audit_timeline`). */
export interface AuditEvent {
  ts: string;
  kind:
    | "lifecycle"
    | "prompt"
    | "command"
    | "file_write"
    | "tool_call"
    | "permission_request"
    | "permission_decision"
    | "resource_request"
    | "error";
  /** Human-readable description. */
  detail: string;
  /** Expandable payload (command text / file diff / decision outcome), if any. */
  extra?: string;
  level: string;
  account?: string;
}

/** Live health of a running connector (daemon + adapter), from `connector_health`. */
export interface ConnectorHealth {
  pid: number;
  /** Summed %CPU across the process group (can exceed 100 on multiple cores). */
  cpu_pct: number;
  /** Summed resident memory across the group, in megabytes. */
  mem_mb: number;
  /** Leader wedged (zombie/stopped) — the "not responding" case. */
  hung: boolean;
  mem_bytes: number;
  process_count: number;
  leader_state: string | null;
  status: "healthy" | "high_cpu" | "high_mem" | "stuck" | string;
}

/** Per-agent npm update status, from `check_agent_updates`. */
export interface AgentUpdate {
  key: string;
  label: string;
  package: string;
  /** Installed global version, or null when not installed. */
  installed: string | null;
  /** Latest published version, or null when offline / not queried. */
  latest: string | null;
  outdated: boolean;
}

// ── A2: live changed-files watch + git status / diff / revert / open-PR ──

/** Start the FSEvents watcher on a connector's workdir. Emits debounced
 *  `connector-changes` events until `connectorWatchStop`. */
export async function connectorWatchStart(name: string): Promise<void> {
  await invokeDesktop("connector_watch_start", { name });
}

/** Stop (and drop) the FSEvents watcher for a connector. Idempotent. */
export async function connectorWatchStop(name: string): Promise<void> {
  await invokeDesktop("connector_watch_stop", { name });
}

/** One-shot git status of a connector's workdir. */
export async function connectorGitStatus(name: string): Promise<GitStatus> {
  return invokeDesktop<GitStatus>("connector_git_status", { name });
}

/** Unified `git diff` of a single file in the workdir (path-guarded on Rust). */
export async function connectorFileDiff(name: string, path: string): Promise<string> {
  return invokeDesktop<string>("connector_file_diff", { name, path });
}

/** Discard uncommitted changes to a tracked file (`git checkout -- path`).
 *  Destructive — callers must confirm first. Path-guarded on the Rust side. */
export async function connectorFileRevert(name: string, path: string): Promise<void> {
  await invokeDesktop("connector_file_revert", { name, path });
}

/** Best-effort "open PR": `gh pr create --web`, else a derived compare URL. */
export async function connectorOpenPr(name: string): Promise<void> {
  await invokeDesktop("connector_open_pr", { name });
}

/** Subscribe to the debounced `connector-changes` FSEvents stream. Returns an
 *  unlisten fn; no-op in the browser. Filter by `payload.name` at the call site
 *  when several watchers are live. */
export async function onConnectorChanges(
  handler: (payload: ChangesPayload) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<ChangesPayload>("connector-changes", (evt) => handler(evt.payload));
}

// ── A3: drag-to-grant allowed_roots ──

/** Append absolute directory paths to a connector's `allowed_roots` (reusing the
 *  structure-preserving toml_edit write) and RESTART its daemon. Takes the
 *  connector NAME (the Rust side resolves its config from daemon.json and
 *  restarts internally — do not call connectorRestart separately). */
export async function connectorAddAllowedRoots(name: string, roots: string[]): Promise<void> {
  await invokeDesktop("connector_add_allowed_roots", { name, roots });
}

/** A native OS file/folder drop onto the window (Finder → webview). With Tauri
 *  `dragDropEnabled` on (its default) the OS drop is captured by Tauri and
 *  delivered here with ABSOLUTE paths + a physical cursor position — HTML5 drop
 *  events never fire for these. Positions are converted to CSS pixels so callers
 *  can `document.elementFromPoint(x, y)`. No-op (no-op unlisten) in the browser. */
export type FileDrop =
  | { type: "enter" | "over"; x: number; y: number }
  | { type: "drop"; paths: string[]; x: number; y: number }
  | { type: "leave" };

export async function onFileDrop(handler: (e: FileDrop) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") return handler({ type: "leave" });
    const dpr = window.devicePixelRatio || 1;
    const x = payload.position.x / dpr;
    const y = payload.position.y / dpr;
    if (payload.type === "drop") handler({ type: "drop", paths: payload.paths, x, y });
    else handler({ type: payload.type, x, y });
  });
}

// ── A4: read-only audit timeline ──

/** Parse a connector's stdout tracing log into a chronological event timeline
 *  (read-only; the newest `lines` events). */
export async function connectorAuditTimeline(
  name: string,
  lines?: number
): Promise<AuditEvent[]> {
  return invokeDesktop<AuditEvent[]>("connector_audit_timeline", { name, lines });
}

// ── C8: live health of a running connector ──

/** Sample live CPU/memory for ONE running connector (daemon + adapter group).
 *  null when the connector isn't running. */
export async function connectorHealth(name: string): Promise<ConnectorHealth | null> {
  return invokeDesktop<ConnectorHealth | null>("connector_health", { name });
}

// ── C9: agent adapter npm updates ──

/** Installed vs latest versions of the known ACP adapter npm packages. */
export async function checkAgentUpdates(): Promise<AgentUpdate[]> {
  return invokeDesktop<AgentUpdate[]>("check_agent_updates");
}
