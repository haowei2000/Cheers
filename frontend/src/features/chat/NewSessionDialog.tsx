// New-session dialog — extracted from SessionsPanel so both the Sessions board
// and the composer's session chip share one creation flow. Pick a bot (only
// those the caller holds a session_create grant for) + optional working
// directory / extra roots, with allowed-root suggestions from the connector's
// workspace policy.
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Plus } from "lucide-react";
import { createChannelBotSession } from "@/api/sessionControl";
import { getWorkspaceMeta, type WorkspaceMeta } from "@/api/workspace";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function NewSessionDialog({
  channelId,
  bots,
  onClose,
  onCreated,
}: {
  channelId: string;
  /** Bots the caller may create sessions for: id → label. */
  bots: { id: string; label: string }[];
  onClose: () => void;
  /** Fires with the created session so callers can refetch and/or auto-target it. */
  onCreated: (created: { session_id: string; bot_id: string }) => void;
}) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [dirs, setDirs] = useState("");
  const [busy, setBusy] = useState(false);
  // The connector's workspace policy for the selected bot — turns the blind
  // absolute-path inputs into a pick-from-allowed-roots affordance. Best-effort:
  // null (offline connector / older gateway) keeps the plain inputs.
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  useEffect(() => {
    if (!botId) {
      setMeta(null);
      return;
    }
    let alive = true;
    getWorkspaceMeta(channelId, botId)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMeta(null));
    return () => {
      alive = false;
    };
  }, [channelId, botId]);

  async function create() {
    if (!botId || busy) return;
    setBusy(true);
    try {
      const trimmedCwd = cwd.trim();
      const additional = dirs
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const created = await createChannelBotSession(
        channelId,
        botId,
        trimmedCwd || additional.length
          ? { cwd: trimmedCwd || undefined, additional_dirs: additional.length ? additional : undefined }
          : undefined
      );
      toast.success("New session created");
      onCreated({ session_id: created.session_id, bot_id: botId });
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New session" onClose={onClose} maxWidth="max-w-sm">
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Bot</span>
          <select
            value={botId}
            disabled={busy}
            onChange={(e) => setBotId(e.target.value)}
            className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Working directory (optional)</span>
          <input
            type="text"
            value={cwd}
            disabled={busy}
            placeholder={meta?.default_cwd ?? "/abs/workdir"}
            list="ws-allowed-roots"
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {/* Datalist = suggestions, not a constraint: any path under an allowed root works. */}
          <datalist id="ws-allowed-roots">
            {meta?.allowed_roots.map((r) => <option key={r} value={r} />)}
          </datalist>
          {meta && meta.allowed_roots.length > 0 && (
            <span className="block text-[10px] text-zinc-400">
              {meta.backend_may_set_cwd
                ? "Must be inside an allowed root: "
                : "This connector does not let the platform set a working directory. Allowed roots: "}
              {meta.allowed_roots.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => setCwd(r)}
                  className="font-mono text-zinc-400 hover:text-indigo-300 underline decoration-dotted"
                >
                  {r}
                  {i < meta.allowed_roots.length - 1 ? ", " : ""}
                </button>
              ))}
            </span>
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Extra roots (optional)</span>
          <textarea
            value={dirs}
            disabled={busy}
            rows={2}
            placeholder={"/abs/extra-root"}
            onChange={(e) => setDirs(e.target.value)}
            className="w-full rounded-lg bg-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <span className="block text-[10px] text-zinc-400">One absolute path per line.</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !botId} onClick={() => void create()}>
            <Plus className="w-3.5 h-3.5" />
            {busy ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
