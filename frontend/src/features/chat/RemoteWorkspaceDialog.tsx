import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  ArrowUp,
  Download,
  FileText,
  Folder,
  GitBranch,
  GitCompare,
  Loader2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  downloadWorkspaceFile,
  getGitDiff,
  getGitStatus,
  getWorkspaceFile,
  getWorkspaceTree,
  listWorkspaceBots,
  putWorkspaceFile,
  type GitStatus,
  type GitStatusEntry,
  type WorkspaceBot,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "@/api/workspace";
import { DiffView } from "./DiffView";

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

export function RemoteWorkspaceDialog({
  channelId,
  onClose,
  initialBotId,
  initialPath,
  sessionId,
  workspaceTick,
}: {
  channelId: string;
  onClose: () => void;
  initialBotId?: string;
  initialPath?: string;
  /** Scope the browse to a session's root set (`cwd` + additionalDirectories). */
  sessionId?: string;
  /** Live-push tick for the "workspace" board (the agent finished a turn on its
   *  machine): bump → refetch the current directory + a clean (non-dirty) open file. */
  workspaceTick?: number;
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
  const deepLinked = useRef(false);
  // Session-scoped by default: browse only the active session's root set. Un-checking
  // "整个允许目录" drops the session id so the user sees the bot's ENTIRE allowed roots.
  const [scoped, setScoped] = useState(true);
  const effectiveSessionId = scoped ? sessionId : undefined;

  // ── Read-only git visibility for the current directory's repo (supplementary) ──
  // Cleared silently when the dir isn't a git repo (E_NOT_A_REPO / HTTP 409) or git
  // ops are unavailable — never routed into `err`, so a non-repo browse stays quiet.
  const [git, setGit] = useState<GitStatus | null>(null);
  // Left pane: the file tree ("files") vs the dirty-file list ("changes").
  const [leftView, setLeftView] = useState<"files" | "changes">("files");
  // A diff shown in the RIGHT pane, overlaying the editor non-destructively. `path`
  // is the change's repo-relative path; "" = the whole working tree.
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    listWorkspaceBots(channelId)
      .then((bs) => {
        if (!alive) return;
        setBots(bs);
        if (!botId) {
          const online = bs.find((b) => b.online);
          if (online) setBotId(online.bot_id);
        }
      })
      .catch((e) => alive && setErr(cleanErr(e)));
    return () => {
      alive = false;
    };
  }, [channelId, botId]);

  const loadDir = useCallback(
    async (path: string) => {
      if (!botId) return;
      setBusy(true);
      setErr(null);
      setFile(null);
      try {
        const t = await getWorkspaceTree(channelId, botId, path, undefined, effectiveSessionId);
        setEntries(t.entries);
        setCwd(t.path);
      } catch (e) {
        setErr(cleanErr(e));
      } finally {
        setBusy(false);
      }
    },
    [channelId, botId, effectiveSessionId]
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!botId) return;
      setBusy(true);
      setErr(null);
      try {
        const f = await getWorkspaceFile(channelId, botId, path, undefined, effectiveSessionId);
        setFile(f);
        setEdit(f.content ?? "");
        setDirty(false);
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
    [channelId, botId, loadDir, effectiveSessionId]
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
      setGit(await getGitStatus(channelId, botId, cwd, undefined, effectiveSessionId));
    } catch {
      setGit(null);
    }
  }, [channelId, botId, cwd, effectiveSessionId]);

  // Refetch whenever the browse context changes (bot / directory / scope).
  useEffect(() => {
    void loadGitStatus();
  }, [loadGitStatus]);

  // Leaving a git repo (git → null) drops the Changes view + any open diff.
  useEffect(() => {
    if (!git) {
      setLeftView("files");
      setDiff(null);
    }
  }, [git]);

  // Load a change's diff (path === "" = the whole working tree) into the right pane,
  // without disturbing any open/dirty editor buffer.
  const openDiff = useCallback(
    async (path: string) => {
      if (!botId) return;
      setDiffBusy(true);
      setErr(null);
      try {
        const d = await getGitDiff(channelId, botId, path, false, undefined, effectiveSessionId);
        setDiff({ path, text: d.diff });
      } catch (e) {
        setErr(cleanErr(e));
      } finally {
        setDiffBusy(false);
      }
    },
    [channelId, botId, effectiveSessionId]
  );

  // Refresh the current dir + git status together; re-fetch an open diff so it stays live.
  const refreshAll = useCallback(() => {
    void loadDir(cwd);
    void loadGitStatus();
    if (diff) void openDiff(diff.path);
  }, [loadDir, cwd, loadGitStatus, diff, openDiff]);

  // The git marker for a tree entry, matched by path suffix; prefer the most specific
  // (longest) match, falling back to an exact one. Directories are never decorated.
  const markFor = useCallback(
    (entPath: string): { m: string; cls: string } | null => {
      if (!git) return null;
      let best: GitStatusEntry | null = null;
      for (const e of git.entries) {
        if (!pathSuffixMatch(e.path, entPath)) continue;
        if (e.path === entPath) return gitMark(e.xy);
        if (!best || e.path.length > best.path.length) best = e;
      }
      return best ? gitMark(best.xy) : null;
    },
    [git]
  );

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
    setCwd("");
    setGit(null);
    setDiff(null);
  }, []);

  // Live-push: the "workspace" board ticked → the agent changed files on this bot's
  // machine. Refetch the current directory; refetch the open file only if it's clean, so
  // a dirty buffer is never clobbered. Only acts on a genuine tick change (not on mount).
  // NOTE: the board tick carries no bot_id through the onBoardSignal seam, so this reacts
  // to any "workspace" tick for the channel; the refetch is non-destructive.
  const seenWsTick = useRef(workspaceTick);
  useEffect(() => {
    if (workspaceTick === undefined || workspaceTick === seenWsTick.current) return;
    seenWsTick.current = workspaceTick;
    if (!botId) return;
    void loadDir(cwd);
    void loadGitStatus();
    if (file && !dirty) void openFile(file.path);
    if (diff) void openDiff(diff.path);
  }, [workspaceTick, botId, cwd, file, dirty, loadDir, openFile, loadGitStatus, diff, openDiff]);

  const save = async () => {
    if (!file || !botId) return;
    setBusy(true);
    setErr(null);
    try {
      await putWorkspaceFile(channelId, botId, file.path, edit, undefined, effectiveSessionId);
      setDirty(false);
    } catch (e) {
      setErr(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };

  const parent = cwd ? cwd.split("/").slice(0, -1).join("/") : null;
  const isImage = file?.content_type.startsWith("image/");

  return (
    <Dialog title="Remote workspace" onClose={onClose} maxWidth="max-w-5xl">
      {/* Bot picker */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-zinc-500">Bot</span>
        <select
          value={botId ?? ""}
          onChange={(e) => {
            setBotId(e.target.value || null);
            setEntries(null);
            setFile(null);
            setGit(null);
            setDiff(null);
            deepLinked.current = true; // manual switch: don't re-deep-link
          }}
          className="bg-zinc-800 text-zinc-200 rounded px-2 py-1 outline-none"
        >
          <option value="">{bots === null ? "Loading…" : "Select a bot"}</option>
          {bots?.map((b) => (
            <option key={b.bot_id} value={b.bot_id} disabled={!b.online}>
              {b.display_name || b.username} {b.online ? "" : "(offline)"}
            </option>
          ))}
        </select>
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {err && <span className="text-red-400 truncate" title={err}>{err}</span>}
        <div className="flex-1" />
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
          <span className="text-zinc-500">
            {git.entries.length} change{git.entries.length === 1 ? "" : "s"}
          </span>
        </div>
      )}

      {!botId ? (
        <div className="py-10 text-center text-xs text-zinc-600">
          Select an online bot to browse the workspace on its machine.
        </div>
      ) : (
        <div className="flex gap-3 h-[62vh]">
          {/* Tree pane */}
          <div className="w-1/3 min-w-[200px] border border-zinc-800 rounded overflow-hidden flex flex-col">
            {/* Files / Changes switch — Changes only appears for a git repo. */}
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
              </div>
            )}

            {leftView === "changes" && git ? (
              <>
                <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800 text-[11px] text-zinc-400">
                  <button
                    onClick={() => openDiff("")}
                    title="Diff the whole working tree"
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-zinc-800 ${
                      diff?.path === "" ? "bg-zinc-800 text-zinc-100" : ""
                    }`}
                  >
                    <GitCompare className="w-3.5 h-3.5" /> Working tree
                  </button>
                  <div className="flex-1" />
                  {diffBusy && <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />}
                  <button onClick={refreshAll} title="Refresh" className="p-0.5 rounded hover:bg-zinc-800">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {git.entries.map((e) => {
                    const mk = gitMark(e.xy);
                    return (
                      <button
                        key={e.path}
                        onClick={() => openDiff(e.path)}
                        title={e.path}
                        className={`flex items-center gap-1.5 w-full px-2 py-1 text-left text-xs hover:bg-zinc-800 ${
                          diff?.path === e.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-300"
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
                  })}
                  {git.entries.length === 0 && (
                    <div className="px-2 py-3 text-[11px] text-zinc-600">Working tree clean</div>
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
                  <button onClick={refreshAll} title="Refresh" className="p-0.5 rounded hover:bg-zinc-800">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {entries?.map((ent) => {
                    const mk = ent.is_dir ? null : markFor(ent.path);
                    return (
                      <button
                        key={ent.path}
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
          <div className="flex-1 border border-zinc-800 rounded overflow-hidden flex flex-col">
            {diff !== null ? (
              <>
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 text-xs">
                  <GitCompare className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                  <span
                    className="text-zinc-200 truncate flex-1 font-mono"
                    title={diff.path || "(working tree)"}
                  >
                    {diff.path || "Working tree"}
                  </span>
                  {diffBusy && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
                  <button
                    onClick={() => setDiff(null)}
                    title="Close diff and return to the file view"
                    className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300"
                  >
                    <X className="w-3 h-3" /> Close
                  </button>
                </div>
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
                  {file.is_text && dirty && (
                    <button
                      onClick={save}
                      title="Save changes back to the bot's machine"
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-zinc-100"
                    >
                      <Save className="w-3 h-3" /> Save
                    </button>
                  )}
                  <button
                    onClick={() => downloadWorkspaceFile(file)}
                    title="Download this file"
                    className="flex items-center gap-1 px-2 py-0.5 rounded hover:bg-zinc-800 text-zinc-300"
                  >
                    <Download className="w-3 h-3" /> Download
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {file.is_text ? (
                    <textarea
                      value={edit}
                      onChange={(e) => {
                        setEdit(e.target.value);
                        setDirty(true);
                      }}
                      spellCheck={false}
                      className="w-full h-full resize-none bg-zinc-950 text-zinc-200 font-mono text-xs p-2 outline-none"
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
    </Dialog>
  );
}
