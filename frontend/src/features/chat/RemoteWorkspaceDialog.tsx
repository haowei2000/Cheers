import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FloatingPanel } from "@/components/ui/floating-panel";
import {
  ArrowUp,
  FolderTree,
  Download,
  FileText,
  Folder,
  GitBranch,
  GitCommit,
  GitCompare,
  History,
  Loader2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  downloadWorkspaceFile,
  getGitCommitFiles,
  getGitDiff,
  getGitLog,
  getGitShow,
  getGitStatus,
  getWorkspaceFile,
  getWorkspaceMeta,
  getWorkspaceTree,
  listWorkspaceBots,
  putWorkspaceFile,
  unwatchWorkspace,
  watchWorkspace,
  WorkspaceConflictError,
  type GitCommit as GitCommitInfo,
  type GitCommitFile,
  type GitStatus,
  type GitStatusEntry,
  type WorkspaceBot,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceMeta,
} from "@/api/workspace";
import { DiffView } from "./DiffView";
import type { PresenceFocus } from "./hooks/useChatRealtime";

/**
 * Browse a *specific bot's* real working machine. A channel can have several bots,
 * each on its own connector/machine, so everything is keyed by the selected bot.
 * Deep-link (from a linkified path in a bot reply) via initialBotId + initialPath.
 */
/** Turn an API error into a human message (strip the JSON envelope / "bad request:"). */
function cleanErr(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  try {
    const j = JSON.parse(s) as { detail?: string };
    if (j?.detail) return j.detail.replace(/^bad request:\s*/, "");
  } catch {
    /* not JSON */
  }
  return s.replace(/^Error:\s*/, "");
}

/**
 * Compact git marker for a porcelain-v2 status code (the two-char XY = index+worktree).
 * Returns the single-letter badge + color, or null for ignored (`!!`) entries we don't
 * decorate. E.g. `??`→untracked, `.M`/`M.`/`MM`→M, `A.`→A, `.D`→D, `R.`→rename.
 */
function gitMark(xy: string): { m: string; cls: string } | null {
  if (xy === "!!") return null;
  if (xy === "??") return { m: "?", cls: "text-zinc-500" };
  if (xy.includes("D")) return { m: "D", cls: "text-rose-400" };
  if (xy.includes("A")) return { m: "A", cls: "text-emerald-400" };
  if (xy.includes("R")) return { m: "R", cls: "text-sky-400" };
  return { m: "M", cls: "text-amber-400" };
}

/**
 * Match a git status path (repo-root-relative) against a tree entry path (workspace-
 * root-relative). The two share the same tail; only the prefix depth differs by where
 * the git repo root sits vs the browsed root. So compare by whole trailing path
 * segments — a match means every overlapping tail segment is equal (e.g. `src/a.ts`
 * matches `proj/src/a.ts` and `a.ts`, but never `lib/a.ts`).
 */
function pathSuffixMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 1; i <= n; i++) {
    if (as[as.length - i] !== bs[bs.length - i]) return false;
  }
  return true;
}

/** Compact relative age for an ISO-8601 date (falls back to the raw string). */
function relDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Commits per history page (`git log -n LOG_PAGE --skip=…`). */
const LOG_PAGE = 50;

/** A file (index) status char that means the change is staged (not `.` clean, not `?` untracked). */
function isStagedCode(xy: string): boolean {
  return xy[0] !== "." && xy[0] !== "?";
}
/** A worktree status char that means the change is unstaged or untracked (not `.` clean). */
function isUnstagedCode(xy: string): boolean {
  return xy[1] !== ".";
}

export function RemoteWorkspaceDialog({
  channelId,
  onClose,
  initialBotId,
  initialPath,
  sessionId,
  workspaceTick,
  workspaceSignal,
  sendPresenceFocus,
  workspaceFocus,
  currentUserId,
  memberNames,
}: {
  channelId: string;
  onClose: () => void;
  initialBotId?: string;
  initialPath?: string;
  /** Scope the browse to a session's root set (`cwd` + additionalDirectories). */
  sessionId?: string;
  /** Broadcast the caller's own workspace focus (bot + path) so peers see it; `null`
   *  clears it. Sent on open/navigate/bot-switch and cleared on close/unmount. */
  sendPresenceFocus?: (
    channelId: string,
    focus: { bot_id: string; path?: string | null } | null
  ) => void;
  /** Workspace presence from the `presence` frame: who is viewing which bot's workspace.
   *  Rendered as viewer chips (filtered to THIS bot, minus the current user). */
  workspaceFocus?: PresenceFocus[];
  /** The viewing user's id — used to drop the caller from the viewer chips. */
  currentUserId?: string;
  /** user_id → display name, to label the viewer chips (falls back to a short id). */
  memberNames?: Map<string, string>;
  /** Live-push tick for the "workspace" board (the agent finished a turn on its
   *  machine): bump → refetch the current directory + a clean (non-dirty) open file. */
  workspaceTick?: number;
  /** Live-watch signal: the agent touched file(s) on a specific bot's machine. The
   *  dialog registers a watch while open and reacts only to signals for ITS `botId`.
   *  `seq` bumps per signal so repeats (same paths) still trigger a refetch. */
  workspaceSignal?: {
    botId: string;
    root: string;
    paths: string[];
    seq: number;
  } | null;
}) {
  const [bots, setBots] = useState<WorkspaceBot[] | null>(null);
  const [botId, setBotId] = useState<string | null>(initialBotId ?? null);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<WorkspaceEntry[] | null>(null);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [edit, setEdit] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Optimistic-concurrency version of the open file; sent back as `If-Match` on save.
  const [etag, setEtag] = useState<string | null>(null);
  // Set when a conditional save lost a race (the file changed on the bot's machine).
  const [conflict, setConflict] = useState<{ currentEtag: string | null; sizeBytes: number } | null>(
    null
  );
  const deepLinked = useRef(false);
  // Session-scoped by default: browse only the active session's root set. Un-checking
  // "整个允许目录" drops the session id so the user sees the bot's ENTIRE allowed roots.
  const [scoped, setScoped] = useState(true);
  const effectiveSessionId = scoped ? sessionId : undefined;
  // Workspace policy metadata (allowed/effective roots, cwd, git availability) for the
  // selected bot + scope; backs the root picker. Best-effort — null hides the picker.
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  // Explicitly selected browse root (one of meta.effective_roots). null = "Auto"
  // (connector default: session root / default_cwd / first allowed root).
  const [root, setRoot] = useState<string | null>(null);

  // ── Read-only git visibility for the current directory's repo (supplementary) ──
  // Cleared silently when the dir isn't a git repo (E_NOT_A_REPO / HTTP 409) or git
  // ops are unavailable — never routed into `err`, so a non-repo browse stays quiet.
  const [git, setGit] = useState<GitStatus | null>(null);
  // Left pane: the file tree ("files"), the dirty-file list ("changes"), or the
  // commit log ("history").
  const [leftView, setLeftView] = useState<"files" | "changes" | "history">("files");
  // A diff shown in the RIGHT pane, overlaying the editor non-destructively.
  //   kind "file"   → a working-tree diff; `path` is repo-relative ("" = whole tree),
  //                   `staged` selects the index (true) vs worktree (false) diff.
  //   kind "commit" → a commit's diff (immutable; never auto-refreshed). `files` is
  //                   its changed-file list (--name-status, lazy); `path` non-null
  //                   narrows the shown diff to that one file of the commit.
  type DiffPane =
    | { kind: "file"; path: string; staged: boolean; text: string }
    | {
        kind: "commit";
        hash: string;
        subject: string;
        text: string;
        files: GitCommitFile[] | null;
        path: string | null;
      };
  const [diff, setDiff] = useState<DiffPane | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  // Commit history for the current repo (lazy: loaded when the History view opens).
  const [log, setLog] = useState<GitCommitInfo[] | null>(null);
  const [logBusy, setLogBusy] = useState(false);
  // True once a history page comes back short — hides "Load more".
  const [logDone, setLogDone] = useState(false);
  // Commit data is immutable, so cache it for the dialog's lifetime: re-clicking a
  // commit (or flipping between its files) renders instantly instead of refetching.
  // Keys are bot-scoped; different bots may browse unrelated repos.
  const showCache = useRef(new Map<string, string>()); // `${bot}:${hash}:${path}` → diff
  const commitFilesCache = useRef(new Map<string, GitCommitFile[]>()); // `${bot}:${hash}`

  useEffect(() => {
    let alive = true;
    listWorkspaceBots(channelId)
      .then((bs) => {
        if (!alive) return;
        setBots(bs);
        if (!botId) {
          // Prefer a bot we can actually see into (online + read-visible).
          const online = bs.find((b) => b.online && b.can_read !== false);
          if (online) setBotId(online.bot_id);
        }
      })
      .catch((e) => alive && setErr(cleanErr(e)));
    return () => {
      alive = false;
    };
  }, [channelId, botId]);

  // The explicitly selected browse root (undefined = connector's default choice).
  const rootParam = root ?? undefined;

  const loadDir = useCallback(
    async (path: string) => {
      if (!botId) return;
      setBusy(true);
      setErr(null);
      setFile(null);
      setEtag(null);
      setConflict(null);
      try {
        const t = await getWorkspaceTree(channelId, botId, path, rootParam, effectiveSessionId);
        setEntries(t.entries);
        setCwd(t.path);
      } catch (e) {
        setErr(cleanErr(e));
      } finally {
        setBusy(false);
      }
    },
    [channelId, botId, rootParam, effectiveSessionId]
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!botId) return;
      setBusy(true);
      setErr(null);
      try {
        const f = await getWorkspaceFile(channelId, botId, path, rootParam, effectiveSessionId);
        setFile(f);
        setEdit(f.content ?? "");
        setEtag(f.etag);
        setDirty(false);
        setConflict(null);
        setDiff(null); // opening a file returns the right pane to the editor
      } catch (e) {
        // A directory clicked via deep-link: fall back to listing it.
        if (String(e).includes("E_IS_DIR")) {
          await loadDir(path);
        } else {
          setErr(cleanErr(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [channelId, botId, loadDir, rootParam, effectiveSessionId]
  );

  // Fetch git state for the *current directory's* repo. Supplementary: any failure
  // (not-a-repo 409 / git disabled 403 / offline) clears it silently — the dialog's
  // `err` stays reserved for the browse itself.
  const loadGitStatus = useCallback(async () => {
    if (!botId) {
      setGit(null);
      return;
    }
    try {
      setGit(await getGitStatus(channelId, botId, cwd, rootParam, effectiveSessionId));
    } catch {
      setGit(null);
    }
  }, [channelId, botId, cwd, rootParam, effectiveSessionId]);

  // Workspace policy metadata for the selected bot + scope (best-effort; backs the
  // root picker and the git-availability hint). An explicit root that fell out of
  // the new effective set is dropped back to Auto.
  useEffect(() => {
    if (!botId) {
      setMeta(null);
      return;
    }
    let alive = true;
    getWorkspaceMeta(channelId, botId, effectiveSessionId)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        setRoot((r) => (r && !m.effective_roots.includes(r) ? null : r));
      })
      .catch(() => alive && setMeta(null));
    return () => {
      alive = false;
    };
  }, [channelId, botId, effectiveSessionId]);

  // Refetch whenever the browse context changes (bot / directory / scope).
  useEffect(() => {
    void loadGitStatus();
  }, [loadGitStatus]);

  // Leaving a git repo (git → null) drops the Changes/History views + any open diff.
  useEffect(() => {
    if (!git) {
      setLeftView("files");
      setDiff(null);
      setLog(null);
    }
  }, [git]);

  // Load a change's diff (path === "" = the whole working tree) into the right pane,
  // without disturbing any open/dirty editor buffer. `staged` picks the index diff
  // (git diff --staged) vs the worktree diff.
  const openDiff = useCallback(
    async (path: string, staged: boolean) => {
      if (!botId) return;
      setDiffBusy(true);
      setErr(null);
      try {
        const d = await getGitDiff(channelId, botId, path, staged, rootParam, effectiveSessionId);
        setDiff({ kind: "file", path, staged, text: d.diff });
      } catch (e) {
        setErr(cleanErr(e));
      } finally {
        setDiffBusy(false);
      }
    },
    [channelId, botId, rootParam, effectiveSessionId]
  );

  // Load a commit's diff into the right pane — the whole commit (`path` null) or one
  // file of it. Commits are immutable, so both the diff text and the changed-file
  // list are cached per (bot, hash): re-opening is instant and never refetched.
  const openCommit = useCallback(
    async (c: GitCommitInfo, path: string | null = null) => {
      if (!botId) return;
      const showKey = `${botId}:${c.hash}:${path ?? ""}`;
      const filesKey = `${botId}:${c.hash}`;
      const cachedText = showCache.current.get(showKey);
      const cachedFiles = commitFilesCache.current.get(filesKey) ?? null;
      if (cachedText != null && cachedFiles != null) {
        setDiff({
          kind: "commit",
          hash: c.hash,
          subject: c.subject,
          text: cachedText,
          files: cachedFiles,
          path,
        });
        return;
      }
      setDiffBusy(true);
      setErr(null);
      try {
        const [s, cf] = await Promise.all([
          cachedText != null
            ? Promise.resolve(null)
            : getGitShow(channelId, botId, c.hash, rootParam, effectiveSessionId, path ?? undefined),
          cachedFiles != null
            ? Promise.resolve(null)
            : getGitCommitFiles(channelId, botId, c.hash, rootParam, effectiveSessionId).catch(
                () => null // file list is an enhancement — the diff still renders without it
              ),
        ]);
        const text = cachedText ?? s?.diff ?? "";
        const files = cachedFiles ?? cf?.files ?? null;
        showCache.current.set(showKey, text);
        if (files) commitFilesCache.current.set(filesKey, files);
        setDiff({ kind: "commit", hash: c.hash, subject: c.subject, text, files, path });
      } catch (e) {
        setErr(cleanErr(e));
      } finally {
        setDiffBusy(false);
      }
    },
    [channelId, botId, rootParam, effectiveSessionId]
  );

  // Load the FIRST page of the commit log for the current directory's repo.
  const loadLog = useCallback(async () => {
    if (!botId) {
      setLog(null);
      return;
    }
    setLogBusy(true);
    try {
      const r = await getGitLog(channelId, botId, cwd, LOG_PAGE, rootParam, effectiveSessionId);
      setLog(r.commits);
      setLogDone(r.commits.length < LOG_PAGE);
    } catch {
      setLog([]);
      setLogDone(true);
    } finally {
      setLogBusy(false);
    }
  }, [channelId, botId, cwd, rootParam, effectiveSessionId]);

  // Append the next page (git log --skip=<loaded so far>). A short page ends paging.
  const loadMoreLog = useCallback(async () => {
    if (!botId || log === null || logBusy || logDone) return;
    setLogBusy(true);
    try {
      const r = await getGitLog(
        channelId,
        botId,
        cwd,
        LOG_PAGE,
        rootParam,
        effectiveSessionId,
        log.length
      );
      // Dedup on hash: a commit landing between pages shifts --skip windows.
      const seen = new Set(log.map((c) => c.hash));
      setLog([...log, ...r.commits.filter((c) => !seen.has(c.hash))]);
      setLogDone(r.commits.length < LOG_PAGE);
    } catch {
      setLogDone(true);
    } finally {
      setLogBusy(false);
    }
  }, [channelId, botId, cwd, rootParam, effectiveSessionId, log, logBusy, logDone]);

  // Lazy-load the history when its view opens (and reload if the browse context changes
  // while it's open — loadLog's identity tracks bot/dir/scope).
  useEffect(() => {
    if (leftView === "history" && git) void loadLog();
  }, [leftView, git, loadLog]);

  // Refresh the current dir + git status together; re-fetch a live (file) diff and the
  // history if open. Commit diffs are immutable, so they are left as-is.
  const refreshAll = useCallback(() => {
    void loadDir(cwd);
    void loadGitStatus();
    if (leftView === "history") void loadLog();
    if (diff?.kind === "file") void openDiff(diff.path, diff.staged);
  }, [loadDir, cwd, loadGitStatus, leftView, loadLog, diff, openDiff]);

  // Debounced live refetch, shared by the board tick and the live-watch signal. An
  // agent touching many files fans MANY signals in quick succession; each refetch is
  // up to 5 parallel requests (tree/status/log/file/diff), so coalesce bursts into
  // one trailing refetch instead of a request wave per signal.
  const refetchTimer = useRef<number | null>(null);
  const scheduleLiveRefetch = useCallback(() => {
    if (refetchTimer.current != null) window.clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      void loadDir(cwd);
      void loadGitStatus();
      if (leftView === "history") void loadLog();
      if (file && !dirty) void openFile(file.path);
      if (diff?.kind === "file") void openDiff(diff.path, diff.staged);
    }, 400);
  }, [loadDir, cwd, loadGitStatus, leftView, loadLog, file, dirty, openFile, diff, openDiff]);
  useEffect(
    () => () => {
      if (refetchTimer.current != null) window.clearTimeout(refetchTimer.current);
    },
    []
  );

  // The git marker per tree entry, matched by path suffix (most specific match wins).
  // Precomputed as a map whenever the listing or the status changes — the old
  // per-row scan was O(files × changes) on EVERY render. Directories undecorated.
  const markMap = useMemo(() => {
    const m = new Map<string, { m: string; cls: string } | null>();
    if (!git || !entries) return m;
    for (const ent of entries) {
      if (ent.is_dir) continue;
      let best: GitStatusEntry | null = null;
      let exact: GitStatusEntry | null = null;
      for (const e of git.entries) {
        if (!pathSuffixMatch(e.path, ent.path)) continue;
        if (e.path === ent.path) {
          exact = e;
          break;
        }
        if (!best || e.path.length > best.path.length) best = e;
      }
      const hit = exact ?? best;
      m.set(ent.path, hit ? gitMark(hit.xy) : null);
    }
    return m;
  }, [git, entries]);

  // When a bot is selected: deep-link to initialPath once, else list the root.
  useEffect(() => {
    if (!botId) return;
    if (initialPath && !deepLinked.current) {
      deepLinked.current = true;
      void openFile(initialPath);
    } else if (entries === null) {
      void loadDir("");
    }
  }, [botId, initialPath, openFile, loadDir, entries]);

  // Flip the session/full-roots scope: reset to the root of the newly-scoped view
  // (the current cwd may not exist under the other root set). Nulling `entries`
  // re-triggers the mount effect above, which re-lists the root with the new scope.
  const toggleScoped = useCallback(() => {
    setScoped((s) => !s);
    setEntries(null);
    setFile(null);
    setEtag(null);
    setConflict(null);
    setCwd("");
    setGit(null);
    setDiff(null);
    setLog(null);
    setLogDone(false);
    setRoot(null); // the other scope has a different effective root set
  }, []);

  // Switch the browse to another allowed root (null = Auto): reset like a scope flip.
  const selectRoot = useCallback((r: string | null) => {
    setRoot(r);
    setEntries(null);
    setFile(null);
    setEtag(null);
    setConflict(null);
    setCwd("");
    setGit(null);
    setDiff(null);
    setLog(null);
    setLogDone(false);
  }, []);

  // Live-push: the "workspace" board ticked → the agent changed files on this bot's
  // machine. Debounce-refetch the current directory; the open file is refetched only
  // if it's clean, so a dirty buffer is never clobbered. Only acts on a genuine tick
  // change (not on mount).
  // NOTE: the board tick carries no bot_id through the onBoardSignal seam, so this reacts
  // to any "workspace" tick for the channel; the refetch is non-destructive.
  const seenWsTick = useRef(workspaceTick);
  useEffect(() => {
    if (workspaceTick === undefined || workspaceTick === seenWsTick.current) return;
    seenWsTick.current = workspaceTick;
    if (!botId) return;
    scheduleLiveRefetch();
  }, [workspaceTick, botId, scheduleLiveRefetch]);

  // ── Live-watch lifecycle ──────────────────────────────────────────────────
  // While the dialog is open on a bot, register interest in the CURRENT directory so
  // the connector fans `workspace_signal` frames when the agent touches files there.
  // Re-watch on navigate/scope/bot change (the deps below unwatch the old registration
  // via cleanup, then register the new one); renew every 60s (safely under the returned
  // TTL) by re-issuing `watch`; unwatch on close/unmount (best-effort — the connector's
  // TTL reaps a leaked registration anyway).
  const watchIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!botId) return;
    let alive = true;
    const register = async () => {
      try {
        const w = await watchWorkspace(channelId, botId, cwd, rootParam, effectiveSessionId);
        if (!alive) {
          // Raced with unmount/navigate: release the just-created watch immediately.
          void unwatchWorkspace(channelId, botId, w.watch_id).catch(() => {});
          return;
        }
        watchIdRef.current = w.watch_id;
      } catch {
        /* watch is best-effort; manual Refresh + workspaceTick still work without it */
      }
    };
    void register();
    // Renew on a fixed interval under a typical multi-minute TTL. Re-issuing `watch`
    // refreshes the registration; we don't stack intervals (one per effect run).
    const renew = setInterval(() => void register(), 60_000);
    return () => {
      alive = false;
      clearInterval(renew);
      const wid = watchIdRef.current;
      watchIdRef.current = null;
      if (wid) void unwatchWorkspace(channelId, botId, wid).catch(() => {});
    };
  }, [channelId, botId, cwd, rootParam, effectiveSessionId]);

  // ── Refresh on a live-watch signal ────────────────────────────────────────
  // A `workspace_signal` for THIS bot arrived (the agent changed files on its machine):
  // debounce-refetch the listing + git status, the open history/live diff, and a CLEAN
  // open file. A dirty buffer is NEVER clobbered (the safe-writes conflict UI still
  // guards Save). Routed by bot_id; the `seq` guard consumes each signal exactly once;
  // the shared debounce coalesces a burst of signals into one trailing refetch.
  const seenSignalSeq = useRef(workspaceSignal?.seq);
  useEffect(() => {
    if (!workspaceSignal || workspaceSignal.seq === seenSignalSeq.current) return;
    seenSignalSeq.current = workspaceSignal.seq;
    // Not for the bot we're browsing (or none selected): consume + ignore.
    if (!botId || workspaceSignal.botId !== botId) return;
    scheduleLiveRefetch();
  }, [workspaceSignal, botId, scheduleLiveRefetch]);

  // ── Workspace presence (broadcast our own focus) ──────────────────────────
  // Tell peers which bot's workspace we're viewing, and at what path (the open file,
  // else the current directory). Dedup on (bot, path) via a ref so we DON'T re-send on
  // every render — only when the pair actually changes. Switching bots sends the new
  // focus (which supersedes the old one for this user), so no explicit clear is needed
  // between bots. `path` empty → send undefined (viewing the root).
  const lastFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sendPresenceFocus || !botId) return;
    const path = file?.path ?? cwd ?? "";
    const key = botId + " " + path;
    if (lastFocusRef.current === key) return;
    lastFocusRef.current = key;
    sendPresenceFocus(channelId, { bot_id: botId, path: path || undefined });
  }, [sendPresenceFocus, channelId, botId, file?.path, cwd]);

  // Clear our focus on close/unmount (sendPresenceFocus is a stable callback, so this
  // cleanup runs only when the dialog actually goes away — not on every focus change).
  useEffect(() => {
    return () => {
      lastFocusRef.current = null;
      sendPresenceFocus?.(channelId, null);
    };
  }, [sendPresenceFocus, channelId]);

  // Peers viewing THIS bot's workspace (minus ourselves) → rendered as header chips.
  const viewers = (workspaceFocus ?? []).filter(
    (f) => f.bot_id === botId && f.user_id !== currentUserId
  );

  // Write the buffer back to the bot's machine. `ifEtag` guards the write:
  //   normal Save → the file's stored etag (conditional, 409 on a lost race);
  //   force-overwrite → the conflict's current etag (or undefined = unconditional).
  // A WorkspaceConflictError surfaces the amber conflict panel instead of `err`; on
  // success we adopt the returned etag so a follow-up save doesn't need a re-read.
  // Uses effectiveSessionId (like every other workspace call) so the path resolves
  // against the SAME root set the user is browsing.
  const doSave = async (ifEtag: string | undefined) => {
    if (!file || !botId) return;
    setBusy(true);
    setErr(null);
    try {
      const newEtag = await putWorkspaceFile(
        channelId,
        botId,
        file.path,
        edit,
        rootParam,
        effectiveSessionId,
        ifEtag
      );
      setEtag(newEtag);
      setDirty(false);
      setConflict(null);
    } catch (e) {
      if (e instanceof WorkspaceConflictError) {
        setConflict({ currentEtag: e.currentEtag, sizeBytes: e.sizeBytes });
      } else {
        setErr(cleanErr(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const parent = cwd ? cwd.split("/").slice(0, -1).join("/") : null;
  const isImage = file?.content_type.startsWith("image/");
  const selectedBot = bots?.find((b) => b.bot_id === botId) ?? null;
  // Fail-closed: advertise Save only when the server explicitly says we can write.
  const canWrite = selectedBot?.can_write === true;

  return (
    <FloatingPanel
      title="Remote workspace"
      icon={FolderTree}
      onClose={onClose}
      storageKey="cheers.float.workspace"
      className="w-[1024px]"
      defaultPosClassName="top-16 left-1/2 -translate-x-1/2"
      // Mobile: the panes stack and stretch (max-md:flex-1 inside) — the body must
      // be a non-scrolling flex column there, same as Dialog's fullScreenOnMobile.
      bodyClassName="max-md:flex max-md:flex-col max-md:overflow-hidden"
    >
      {/* Bot picker */}
      <div className="flex items-center gap-2 mb-2 text-xs flex-wrap max-md:flex-shrink-0">
        <span className="text-zinc-500">Bot</span>
        <select
          value={botId ?? ""}
          onChange={(e) => {
            setBotId(e.target.value || null);
            setEntries(null);
            setFile(null);
            setEtag(null);
            setConflict(null);
            setGit(null);
            setDiff(null);
            setLog(null);
            setLogDone(false);
            setRoot(null);
            deepLinked.current = true; // manual switch: don't re-deep-link
          }}
          className="bg-zinc-800 text-zinc-200 rounded px-2 py-1 outline-none"
        >
          <option value="">{bots === null ? "Loading…" : "Select a bot"}</option>
          {bots?.map((b) => (
            <option
              key={b.bot_id}
              value={b.bot_id}
              disabled={!b.online || b.can_read === false}
            >
              {b.display_name || b.username}{" "}
              {!b.online ? "(offline)" : b.can_read === false ? "(no access)" : ""}
            </option>
          ))}
        </select>
        {/* Root picker — only when this scope actually has several roots to choose from. */}
        {meta && meta.effective_roots.length > 1 && (
          <select
            value={root ?? ""}
            onChange={(e) => selectRoot(e.target.value || null)}
            title="Workspace root to browse (the connector's allowed_roots)"
            className="max-w-[220px] bg-zinc-800 text-zinc-300 rounded px-2 py-1 outline-none"
          >
            <option value="">Root: auto</option>
            {meta.effective_roots.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {err && <span className="text-red-400 truncate" title={err}>{err}</span>}
        <div className="flex-1" />
        {meta?.git_ops === "off" && (
          <span
            className="text-zinc-600"
            title="This connector's policy disables git inspection (git_ops = off)"
          >
            git off
          </span>
        )}
        {sessionId && (
          <label
            className="flex items-center gap-1 text-zinc-500 cursor-pointer select-none"
            title="勾选:浏览该 bot 的全部允许目录(不再限定在当前会话的根集)"
          >
            <input
              type="checkbox"
              checked={!scoped}
              onChange={toggleScoped}
              className="accent-emerald-600"
            />
            整个允许目录
          </label>
        )}
      </div>

      {/* Git branch badge — quiet, only when the current dir resolves to a repo. */}
      {botId && git && (
        <div className="flex items-center gap-2 mb-2 text-[11px] text-zinc-400">
          <GitBranch className="w-3 h-3 text-zinc-500 shrink-0" />
          <span
            className="text-zinc-300 font-mono truncate"
            title={git.branch ?? undefined}
          >
            {git.branch || "(detached)"}
          </span>
          {!!git.ahead && <span className="text-emerald-400">↑{git.ahead}</span>}
          {!!git.behind && <span className="text-amber-400">↓{git.behind}</span>}
          {git.upstream && (
            <span
              className="text-zinc-600 font-mono truncate"
              title={`Tracking ${git.upstream}`}
            >
              vs {git.upstream}
            </span>
          )}
          <span className="text-zinc-500">
            {git.entries.length} change{git.entries.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {/* Workspace presence — who ELSE is viewing this bot's workspace right now, so
          co-editing is visible before conflicts happen. */}
      {botId && viewers.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 mb-2 text-[11px]">
          <span className="text-zinc-600 shrink-0">Viewing</span>
          {viewers.map((v) => {
            const name = memberNames?.get(v.user_id) || v.user_id.slice(0, 8);
            const base = v.path ? v.path.split("/").pop() : null;
            // Emphasize when a peer is on the very file we have open.
            const sameFile = !!file && !!v.path && v.path === file.path;
            return (
              <span
                key={v.user_id + ":" + (v.path ?? "")}
                title={v.path ?? name}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${
                  sameFile
                    ? "bg-amber-950/40 text-amber-300"
                    : "bg-zinc-800 text-zinc-400"
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                <span className="text-zinc-300">{name}</span>
                {base && <span className="text-zinc-500 truncate max-w-[140px]">· {base}</span>}
                {sameFile && <span className="text-amber-400 shrink-0">· also editing</span>}
              </span>
            );
          })}
        </div>
      )}

      {!botId ? (
        <div className="py-10 text-center text-xs text-zinc-600">
          Select an online bot to browse the workspace on its machine.
        </div>
      ) : (
        // Desktop: side-by-side tree + editor at a fixed height. Mobile: the dialog is a
        // full-screen sheet (fullScreenOnMobile), so stack the panes vertically and let
        // this body fill the remaining height; each pane keeps its own internal scroll.
        <div className="flex gap-3 h-[62vh] max-md:h-auto max-md:flex-1 max-md:min-h-0 max-md:flex-col">
          {/* Tree pane */}
          <div className="w-1/3 min-w-[200px] max-md:w-full max-md:min-w-0 max-md:h-2/5 max-md:flex-none rounded overflow-hidden flex flex-col">
            {/* Files / Changes / History switch — the latter two only for a git repo. */}
            {git && (
              <div className="flex items-center border-b border-zinc-800 text-[11px]">
                <button
                  onClick={() => {
                    setLeftView("files");
                    setDiff(null);
                  }}
                  className={`px-2.5 py-1.5 ${
                    leftView === "files"
                      ? "text-zinc-100 bg-zinc-800"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  Files
                </button>
                <button
                  onClick={() => setLeftView("changes")}
                  className={`flex items-center gap-1 px-2.5 py-1.5 ${
                    leftView === "changes"
                      ? "text-zinc-100 bg-zinc-800"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  Changes
                  {git.entries.length > 0 && (
                    <span className="text-[10px] text-zinc-400 tabular-nums">
                      {git.entries.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setLeftView("history")}
                  className={`flex items-center gap-1 px-2.5 py-1.5 ${
                    leftView === "history"
                      ? "text-zinc-100 bg-zinc-800"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <History className="w-3 h-3" /> History
                </button>
              </div>
            )}

            {leftView === "changes" && git ? (
              <>
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800 text-[11px] text-zinc-400">
                  <button
                    onClick={() => openDiff("", false)}
                    title="Diff the whole working tree (unstaged)"
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-zinc-800 ${
                      diff?.kind === "file" && diff.path === "" && !diff.staged
                        ? "bg-zinc-800 text-zinc-100"
                        : ""
                    }`}
                  >
                    <GitCompare className="w-3.5 h-3.5" /> Working tree
                  </button>
                  <button
                    onClick={() => openDiff("", true)}
                    title="Diff everything staged (git diff --staged)"
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-zinc-800 ${
                      diff?.kind === "file" && diff.path === "" && diff.staged
                        ? "bg-zinc-800 text-zinc-100"
                        : ""
                    }`}
                  >
                    <GitCompare className="w-3.5 h-3.5" /> Staged
                  </button>
                  <div className="flex-1" />
                  {diffBusy && <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />}
                  <button onClick={refreshAll} title="Refresh" className="p-0.5 rounded hover:bg-zinc-800">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {(() => {
                    // Split by porcelain XY: index char (staged) vs worktree char
                    // (unstaged/untracked). A file can appear in both groups.
                    const staged = git.entries.filter((e) => isStagedCode(e.xy));
                    const unstaged = git.entries.filter((e) => isUnstagedCode(e.xy));
                    const renderRow = (e: GitStatusEntry, isStaged: boolean) => {
                      const mk = gitMark(e.xy);
                      const active =
                        diff?.kind === "file" && diff.path === e.path && diff.staged === isStaged;
                      return (
                        <button
                          key={(isStaged ? "s:" : "u:") + e.path}
                          onClick={() => openDiff(e.path, isStaged)}
                          title={e.path}
                          className={`flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs hover:bg-zinc-800 ${
                            active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"
                          }`}
                        >
                          <span
                            className={`w-3 shrink-0 text-center font-mono text-[10px] ${mk?.cls ?? "text-zinc-500"}`}
                          >
                            {mk?.m ?? "•"}
                          </span>
                          <span className="truncate flex-1">{e.path}</span>
                        </button>
                      );
                    };
                    const label = (text: string, n: number) => (
                      <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                        {text} <span className="tabular-nums text-zinc-400">{n}</span>
                      </div>
                    );
                    return (
                      <>
                        {staged.length > 0 && (
                          <>
                            {label("Staged", staged.length)}
                            {staged.map((e) => renderRow(e, true))}
                          </>
                        )}
                        {unstaged.length > 0 && (
                          <>
                            {label("Unstaged / Untracked", unstaged.length)}
                            {unstaged.map((e) => renderRow(e, false))}
                          </>
                        )}
                        {git.entries.length === 0 && (
                          <div className="px-2 py-3 text-[11px] text-zinc-600">
                            Working tree clean
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </>
            ) : leftView === "history" && git ? (
              <>
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800 text-[11px] text-zinc-400">
                  <span className="flex items-center gap-1 flex-1">
                    <History className="w-3.5 h-3.5" /> Commits
                  </span>
                  {logBusy && <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />}
                  <button
                    onClick={() => void loadLog()}
                    title="Refresh"
                    className="p-0.5 rounded hover:bg-zinc-800"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {log?.map((c) => {
                    const active = diff?.kind === "commit" && diff.hash === c.hash;
                    return (
                      <button
                        key={c.hash}
                        onClick={() => openCommit(c)}
                        title={c.subject}
                        className={`flex flex-col gap-0.5 w-full px-2 py-1.5 text-left border-b border-zinc-900 hover:bg-zinc-800 ${
                          active ? "bg-zinc-800" : ""
                        }`}
                      >
                        <div className="flex items-center gap-1.5 text-xs">
                          <GitCommit className="w-3 h-3 text-zinc-500 shrink-0" />
                          <span className="font-mono text-[10px] text-amber-400 shrink-0">
                            {c.hash.slice(0, 7)}
                          </span>
                          <span
                            className={`truncate flex-1 ${active ? "text-zinc-100" : "text-zinc-300"}`}
                          >
                            {c.subject}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 pl-4 text-[10px] text-zinc-500">
                          <span className="truncate">{c.author}</span>
                          <span className="shrink-0">· {relDate(c.date)}</span>
                        </div>
                      </button>
                    );
                  })}
                  {log !== null && log.length === 0 && !logBusy && (
                    <div className="px-2 py-3 text-[11px] text-zinc-600">No commits</div>
                  )}
                  {log === null && logBusy && (
                    <div className="px-2 py-3 text-[11px] text-zinc-600">Loading…</div>
                  )}
                  {log !== null && log.length > 0 && !logDone && (
                    <button
                      onClick={() => void loadMoreLog()}
                      disabled={logBusy}
                      className="w-full px-2 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                    >
                      {logBusy ? "Loading…" : `Load ${LOG_PAGE} more`}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800 text-[11px] text-zinc-400">
                  <button
                    onClick={() => parent !== null && loadDir(parent)}
                    disabled={!cwd}
                    title="Go up one level"
                    className="p-0.5 rounded hover:bg-zinc-800 disabled:opacity-30"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <span className="truncate flex-1" title={"/" + cwd}>/{cwd}</span>
                  {git && !!cwd && (
                    <button
                      onClick={() => openDiff(cwd, false)}
                      title="Diff this directory (working tree)"
                      className="p-0.5 rounded hover:bg-zinc-800"
                    >
                      <GitCompare className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button onClick={refreshAll} title="Refresh" className="p-0.5 rounded hover:bg-zinc-800">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {entries?.map((ent) => {
                    const mk = ent.is_dir ? null : (markMap.get(ent.path) ?? null);
                    return (
                      <div key={ent.path} className="group/row relative">
                        <button
                          onClick={() => (ent.is_dir ? loadDir(ent.path) : openFile(ent.path))}
                          className={`flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs hover:bg-zinc-800 ${
                            file?.path === ent.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"
                          }`}
                        >
                          {ent.is_dir ? (
                            <Folder className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                          ) : (
                            <FileText className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          )}
                          <span className="truncate flex-1">{ent.name}</span>
                          {mk && (
                            <span
                              className={`shrink-0 font-mono text-[10px] ${mk.cls}`}
                              title={`git: ${mk.m}`}
                            >
                              {mk.m}
                            </span>
                          )}
                        </button>
                        {/* Directory-scoped diff, on hover (repo dirs only). */}
                        {ent.is_dir && git && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void openDiff(ent.path, false);
                            }}
                            title={`Diff ${ent.name}/ (working tree)`}
                            className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover/row:flex items-center p-0.5 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                          >
                            <GitCompare className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {entries?.length === 0 && (
                    <div className="px-2 py-3 text-[11px] text-zinc-600">Empty directory</div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Viewer / editor / diff pane */}
          <div className="flex-1 min-h-0 rounded overflow-hidden flex flex-col">
            {diff !== null ? (
              <>
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 text-xs">
                  {diff.kind === "commit" ? (
                    <>
                      <GitCommit className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                      <span className="font-mono text-[11px] text-amber-400 shrink-0">
                        {diff.hash.slice(0, 7)}
                      </span>
                      <span
                        className="text-zinc-200 truncate flex-1"
                        title={diff.subject}
                      >
                        {diff.subject}
                      </span>
                    </>
                  ) : (
                    <>
                      <GitCompare className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                      <span
                        className="text-zinc-200 truncate flex-1 font-mono"
                        title={diff.path || "(working tree)"}
                      >
                        {diff.path || (diff.staged ? "Staged changes" : "Working tree")}
                      </span>
                      {diff.staged && (
                        <span className="text-[10px] text-emerald-400 shrink-0">staged</span>
                      )}
                    </>
                  )}
                  {diffBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
                  <button
                    onClick={() => setDiff(null)}
                    title="Close diff and return to the file view"
                    className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300"
                  >
                    <X className="w-3 h-3" /> Close
                  </button>
                </div>
                {/* Changed-file strip for a commit: jump between per-file diffs without
                    fetching (cached) or scrolling through the whole patch. */}
                {diff.kind === "commit" && diff.files && diff.files.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 max-h-20 overflow-auto px-2 py-1 border-b border-zinc-800 text-[10px]">
                    <button
                      onClick={() =>
                        void openCommit(
                          { hash: diff.hash, subject: diff.subject, author: "", date: "" },
                          null
                        )
                      }
                      className={`px-1.5 py-0.5 rounded ${
                        diff.path === null
                          ? "bg-zinc-700 text-zinc-100"
                          : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                      }`}
                    >
                      All files ({diff.files.length})
                    </button>
                    {diff.files.map((f) => {
                      const letter = f.status.charAt(0);
                      const cls =
                        letter === "A"
                          ? "text-emerald-400"
                          : letter === "D"
                            ? "text-rose-400"
                            : letter === "R" || letter === "C"
                              ? "text-sky-400"
                              : "text-amber-400";
                      return (
                        <button
                          key={f.path}
                          onClick={() =>
                            void openCommit(
                              { hash: diff.hash, subject: diff.subject, author: "", date: "" },
                              f.path
                            )
                          }
                          title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded font-mono ${
                            diff.path === f.path
                              ? "bg-zinc-700 text-zinc-100"
                              : "bg-zinc-800/70 text-zinc-400 hover:text-zinc-200"
                          }`}
                        >
                          <span className={cls}>{letter}</span>
                          <span className="max-w-[180px] truncate">
                            {f.path.split("/").pop()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <DiffView diff={diff.text} className="flex-1" />
              </>
            ) : !file ? (
              <div className="flex-1 flex items-center justify-center text-xs text-zinc-600">
                Select a file on the left to view it
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 text-xs">
                  <span className="text-zinc-200 truncate flex-1" title={file.path}>
                    {file.filename}
                  </span>
                  <span className="text-zinc-600">{file.size_bytes}B</span>
                  {file.is_text &&
                    (canWrite ? (
                      dirty && (
                        <button
                          onClick={() => doSave(etag ?? undefined)}
                          disabled={busy}
                          title="Save changes back to the bot's machine"
                          className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-zinc-100 disabled:opacity-40"
                        >
                          <Save className="w-3 h-3" /> Save
                        </button>
                      )
                    ) : (
                      <span
                        className="text-amber-400 text-[11px] shrink-0"
                        title="This bot's owner hasn't granted you write access to its workspace."
                      >
                        write requires a grant from the bot owner
                      </span>
                    ))}
                  <button
                    onClick={() => downloadWorkspaceFile(file)}
                    title="Download this file"
                    className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300"
                  >
                    <Download className="w-3 h-3" /> Download
                  </button>
                </div>
                {conflict && (
                  <div className="flex items-center gap-2 max-md:flex-wrap px-2 py-1.5 border-b border-amber-800/50 bg-amber-950/30 text-[11px] text-amber-300">
                    <span className="flex-1">
                      文件已被其他进程修改(远端 {conflict.sizeBytes}B)。「重新载入」会用远端内容替换当前编辑;「强制覆盖」会覆盖远端改动。
                    </span>
                    <button
                      onClick={() => void openFile(file.path)}
                      disabled={busy}
                      title="放弃当前编辑,重新载入远端最新内容"
                      className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 disabled:opacity-40"
                    >
                      <RefreshCw className="w-3 h-3" /> 重新载入
                    </button>
                    <button
                      onClick={() => {
                        if (
                          window.confirm(
                            "强制覆盖会覆盖远端已改动的版本,该版本将丢失。确定继续?"
                          )
                        ) {
                          void doSave(conflict.currentEtag ?? undefined);
                        }
                      }}
                      disabled={busy}
                      title="用当前编辑覆盖远端版本"
                      className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 text-zinc-100 disabled:opacity-40"
                    >
                      <Save className="w-3 h-3" /> 强制覆盖
                    </button>
                  </div>
                )}
                <div className="flex-1 overflow-auto">
                  {file.is_text ? (
                    <textarea
                      value={edit}
                      onChange={(e) => {
                        setEdit(e.target.value);
                        setDirty(true);
                      }}
                      spellCheck={false}
                      // 16px below md prevents iOS Safari's auto-zoom on focus.
                      className="w-full h-full resize-none bg-zinc-950 text-zinc-200 font-mono text-xs max-md:text-base p-2 outline-none"
                    />
                  ) : isImage ? (
                    <img
                      src={`data:${file.content_type};base64,${file.content_b64}`}
                      alt={file.filename}
                      className="max-w-full"
                    />
                  ) : (
                    <div className="p-4 text-xs text-zinc-500">
                      Binary file — no preview. Use "Download" above to get it.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </FloatingPanel>
  );
}
