import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import {
  ArrowUp,
  Download,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import {
  downloadWorkspaceFile,
  getWorkspaceFile,
  getWorkspaceTree,
  listWorkspaceBots,
  putWorkspaceFile,
  type WorkspaceBot,
  type WorkspaceEntry,
  type WorkspaceFile,
} from "@/api/workspace";

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

export function RemoteWorkspaceDialog({
  channelId,
  onClose,
  initialBotId,
  initialPath,
  sessionId,
}: {
  channelId: string;
  onClose: () => void;
  initialBotId?: string;
  initialPath?: string;
  /** Scope the browse to a session's root set (`cwd` + additionalDirectories). */
  sessionId?: string;
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
        const t = await getWorkspaceTree(channelId, botId, path, undefined, sessionId);
        setEntries(t.entries);
        setCwd(t.path);
      } catch (e) {
        setErr(cleanErr(e));
      } finally {
        setBusy(false);
      }
    },
    [channelId, botId, sessionId]
  );

  const openFile = useCallback(
    async (path: string) => {
      if (!botId) return;
      setBusy(true);
      setErr(null);
      try {
        const f = await getWorkspaceFile(channelId, botId, path, undefined, sessionId);
        setFile(f);
        setEdit(f.content ?? "");
        setDirty(false);
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
    [channelId, botId, loadDir, sessionId]
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

  const save = async () => {
    if (!file || !botId) return;
    setBusy(true);
    setErr(null);
    try {
      await putWorkspaceFile(channelId, botId, file.path, edit, undefined, sessionId);
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
      </div>

      {!botId ? (
        <div className="py-10 text-center text-xs text-zinc-600">
          Select an online bot to browse the workspace on its machine.
        </div>
      ) : (
        <div className="flex gap-3 h-[62vh]">
          {/* Tree pane */}
          <div className="w-1/3 min-w-[200px] border border-zinc-800 rounded overflow-hidden flex flex-col">
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
              <button onClick={() => loadDir(cwd)} title="Refresh" className="p-0.5 rounded hover:bg-zinc-800">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {entries?.map((ent) => (
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
                  <span className="truncate">{ent.name}</span>
                </button>
              ))}
              {entries?.length === 0 && (
                <div className="px-2 py-3 text-[11px] text-zinc-600">Empty directory</div>
              )}
            </div>
          </div>

          {/* Viewer / editor pane */}
          <div className="flex-1 border border-zinc-800 rounded overflow-hidden flex flex-col">
            {!file ? (
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
