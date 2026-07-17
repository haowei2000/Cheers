import { useCallback, useEffect, useState } from "react";
import { GitBranch, GitPullRequest, RotateCcw, FileText } from "lucide-react";
import toast from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { invokeDesktop } from "@/lib/desktop";
import {
  connectorWatchStart,
  connectorWatchStop,
  connectorGitStatus,
  connectorFileDiff,
  connectorFileRevert,
  connectorOpenPr,
  onConnectorChanges,
  type GitStatus,
  type FileStatus,
} from "@/lib/desktopConnector";

/** An app that can open a workspace dir (Finder + installed editors). */
interface Opener {
  key: string;
  label: string;
}

/** Colorize a unified diff into per-line spans (no external diff lib). */
function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <p className="text-[11px] text-zinc-500 px-2 py-1">No textual diff (binary or unchanged).</p>;
  }
  return (
    <pre className="text-[11px] bg-zinc-950 rounded-md p-2 overflow-auto max-h-72 leading-relaxed">
      {diff.split("\n").map((line, i) => {
        const c = line[0];
        const cls =
          line.startsWith("+++") || line.startsWith("---")
            ? "text-zinc-500"
            : line.startsWith("@@")
              ? "text-sky-400"
              : c === "+"
                ? "text-emerald-400"
                : c === "-"
                  ? "text-rose-400"
                  : "text-zinc-400";
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** Live changed-files + git status + per-file diff / revert for one connector's
 *  workdir. Purely a LOCAL view: it watches the disk, shells git, and opens
 *  local tools — no message or permission decision touches the gateway. */
export function ConnectorChanges({ name, openers }: { name: string; openers: Opener[] }) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null); // path with an expanded diff
  const [diff, setDiff] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);
  const [busyPr, setBusyPr] = useState(false);

  const load = useCallback(async () => {
    try {
      setGit(await connectorGitStatus(name));
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : "couldn't read git status");
    }
  }, [name]);

  // Start the FSEvents watch + one immediate status read; live-update on the
  // debounced `connector://changes` stream. Cleanup stops the watcher so they
  // don't accumulate across opens.
  useEffect(() => {
    let unlisten = () => {};
    let cancelled = false;
    void connectorWatchStart(name).catch(() => {});
    void load();
    void onConnectorChanges((payload) => {
      if (payload.name === name) setGit(payload.git);
    }).then((u) => (cancelled ? u() : (unlisten = u)));
    return () => {
      cancelled = true;
      unlisten();
      void connectorWatchStop(name).catch(() => {});
    };
  }, [name, load]);

  async function toggleDiff(path: string) {
    if (open === path) {
      setOpen(null);
      return;
    }
    setOpen(path);
    setDiff("");
    setDiffLoading(true);
    try {
      setDiff(await connectorFileDiff(name, path));
    } catch (e) {
      setDiff(typeof e === "string" ? e : "couldn't load diff");
    } finally {
      setDiffLoading(false);
    }
  }

  async function revert(path: string) {
    if (!window.confirm(`Discard all uncommitted changes to\n${path}?\nThis cannot be undone.`)) {
      return;
    }
    setReverting(path);
    try {
      await connectorFileRevert(name, path);
      toast.success("Reverted");
      if (open === path) setOpen(null);
      await load();
    } catch (e) {
      toast.error(typeof e === "string" ? e : "revert failed");
    } finally {
      setReverting(null);
    }
  }

  async function openPr() {
    setBusyPr(true);
    try {
      await connectorOpenPr(name);
    } catch (e) {
      toast.error(typeof e === "string" ? e : "couldn't open a PR");
    } finally {
      setBusyPr(false);
    }
  }

  if (error) {
    return <p className="text-xs text-rose-400">{error}</p>;
  }
  if (git === null) {
    return <p className="text-xs text-zinc-500">Loading…</p>;
  }
  if (!git.is_repo) {
    return (
      <p className="text-xs text-zinc-500">
        This workspace isn't a git repository — no changes to track.
      </p>
    );
  }

  const primaryOpener = openers[0];

  return (
    <div>
      {/* status header */}
      <div className="flex items-center gap-2 mb-3 text-xs">
        <GitBranch className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="font-medium text-zinc-200 truncate">{git.branch || "(detached)"}</span>
        {git.dirty ? (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title="uncommitted changes" />
        ) : (
          <span className="text-[11px] text-zinc-500">clean</span>
        )}
        {(git.ahead > 0 || git.behind > 0) && (
          <span className="text-[11px] text-zinc-500 tabular-nums">
            {git.ahead > 0 && `↑${git.ahead}`} {git.behind > 0 && `↓${git.behind}`}
          </span>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="ml-auto"
          loading={busyPr}
          onClick={() => void openPr()}
        >
          <GitPullRequest className="w-3.5 h-3.5" /> Open PR
        </Button>
      </div>

      {git.files.length === 0 ? (
        <p className="text-xs text-zinc-500">No changed files.</p>
      ) : (
        <ul className="space-y-1 max-h-[55vh] overflow-auto pr-1">
          {git.files.map((f: FileStatus) => (
            <li key={f.path} className="text-xs">
              <div className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-zinc-800/60">
                <span
                  className="font-mono text-[10px] text-zinc-500 w-6 shrink-0 uppercase"
                  title={f.status}
                >
                  {f.status.trim() || "?"}
                </span>
                <button
                  type="button"
                  onClick={() => void toggleDiff(f.path)}
                  className="text-left text-zinc-200 min-w-0 truncate flex-1"
                  dir="rtl"
                  style={{ unicodeBidi: "plaintext" }}
                  title={f.path}
                >
                  {f.path}
                </button>
                {primaryOpener && (
                  <button
                    type="button"
                    title={`Open in ${primaryOpener.label}`}
                    aria-label={`Open in ${primaryOpener.label}`}
                    className="text-zinc-500 hover:text-zinc-200 shrink-0"
                    onClick={() =>
                      void invokeDesktop("open_path", {
                        name,
                        path: f.path,
                        opener: primaryOpener.key,
                      }).catch((e) =>
                        toast.error(typeof e === "string" ? e : "couldn't open the file")
                      )
                    }
                  >
                    <FileText className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  title="Discard changes (revert)"
                  aria-label="Discard changes"
                  disabled={reverting === f.path}
                  className="text-rose-400 hover:text-rose-300 disabled:opacity-40 shrink-0"
                  onClick={() => void revert(f.path)}
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </div>
              {open === f.path && (
                <div className="ml-8 mt-1 mb-1">
                  {diffLoading ? (
                    <p className="text-[11px] text-zinc-500 px-2">Loading diff…</p>
                  ) : (
                    <DiffView diff={diff} />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
