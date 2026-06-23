import { useCallback, useEffect, useState } from "react";
import { FileText, FolderOpen, RefreshCw, Save, Trash2 } from "lucide-react";
import { ResourceError } from "../../hooks/useChatRealtime";
import { registerPanel, type PanelContext } from "../panelRegistry";
import type { FsEntry } from "../fsClient";

function errMsg(e: unknown): string {
  if (e instanceof ResourceError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : "error";
}

// The File plugin: browse + edit the channel workspace fs (memory_files).
// File content is rendered ONLY inside a <textarea> (inert text — no HTML
// execution), so stored content cannot XSS co-channel users.
function FilePanel({ fs }: PanelContext) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fs.ls("");
      setEntries(res.entries.filter((e) => !e.is_dir));
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [fs]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (path: string) => {
      setLoading(true);
      setStatus(null);
      try {
        const f = await fs.read(path);
        setSelected(path);
        setContent(f.content);
        setVersion(f.version);
        setDirty(false);
      } catch (e) {
        setStatus(errMsg(e));
      } finally {
        setLoading(false);
      }
    },
    [fs]
  );

  const save = useCallback(async () => {
    if (selected === null) return;
    setStatus(null);
    try {
      const res = await fs.write(selected, content, version);
      setVersion(res.version);
      setDirty(false);
      setStatus("Saved");
      void refresh();
    } catch (e) {
      if (e instanceof ResourceError && e.code === "VERSION_CONFLICT") {
        setStatus("Conflict — reloaded latest, reapply your edit");
        await open(selected);
      } else {
        setStatus(errMsg(e));
      }
    }
  }, [selected, content, version, fs, refresh, open]);

  const create = useCallback(async () => {
    const path = window.prompt("New file path (e.g. notes/todo.md)");
    if (!path) return;
    setStatus(null);
    try {
      await fs.write(path, "", 0); // create-only
      await refresh();
      await open(path);
    } catch (e) {
      setStatus(errMsg(e));
    }
  }, [fs, refresh, open]);

  const remove = useCallback(
    async (path: string) => {
      if (!window.confirm(`Delete ${path}?`)) return;
      setStatus(null);
      try {
        await fs.rm(path);
        if (selected === path) {
          setSelected(null);
          setContent("");
        }
        await refresh();
      } catch (e) {
        // PERMISSION_DENIED here = needs admin/owner (server-gated destructive op).
        setStatus(errMsg(e));
      }
    },
    [fs, refresh, selected]
  );

  return (
    <div className="flex h-full text-sm">
      {/* file list */}
      <div className="w-44 flex-shrink-0 border-r border-zinc-800 flex flex-col">
        <div className="flex items-center gap-1 px-2 h-8 border-b border-zinc-800 flex-shrink-0">
          <button
            onClick={() => void create()}
            className="text-xs text-zinc-400 hover:text-zinc-100"
          >
            + New
          </button>
          <div className="flex-1" />
          <button onClick={() => void refresh()} title="Refresh">
            <RefreshCw className="w-3.5 h-3.5 text-zinc-500 hover:text-zinc-300" />
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {entries.length === 0 && (
            <div className="px-2 py-3 text-xs text-zinc-600">No files</div>
          )}
          {entries.map((e) => (
            <div
              key={e.path}
              onClick={() => void open(e.path)}
              className={`group flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-zinc-800/60 ${
                selected === e.path ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
              }`}
            >
              <FileText className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
              <span className="truncate flex-1">{e.path}</span>
              <button
                onClick={(ev) => {
                  ev.stopPropagation();
                  void remove(e.path);
                }}
                title="Delete"
                className="opacity-0 group-hover:opacity-100"
              >
                <Trash2 className="w-3 h-3 text-zinc-600 hover:text-red-400" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected === null ? (
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-xs gap-2">
            <FolderOpen className="w-4 h-4" /> Select a file
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 h-8 border-b border-zinc-800 flex-shrink-0">
              <span className="text-xs text-zinc-300 truncate">{selected}</span>
              {dirty && <span className="text-[10px] text-amber-500">●</span>}
              <div className="flex-1" />
              <button
                onClick={() => void save()}
                disabled={!dirty}
                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-40"
              >
                <Save className="w-3.5 h-3.5" /> Save
              </button>
            </div>
            {/* textarea = inert text rendering; never dangerouslySetInnerHTML */}
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              spellCheck={false}
              disabled={loading}
              className="flex-1 resize-none bg-zinc-950 text-zinc-200 font-mono text-xs p-3 outline-none"
            />
          </>
        )}
        {status && (
          <div className="px-3 py-1 text-[11px] text-zinc-500 border-t border-zinc-800 flex-shrink-0">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}

registerPanel({
  id: "files",
  title: "Files",
  render: (ctx) => <FilePanel {...ctx} />,
});

export default FilePanel;
