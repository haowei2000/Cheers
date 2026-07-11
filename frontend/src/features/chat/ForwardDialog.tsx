import { useEffect, useMemo, useState } from "react";
import { Forward, Hash, MessageCircle, Search } from "lucide-react";
import toast from "react-hot-toast";
import { Dialog } from "@/components/ui/dialog";
import { listChannels, listDms } from "@/api/channels";
import { sendMessage } from "@/api/messages";
import type { Channel } from "@/types";

/**
 * Forward picker: choose a channel or DM, then send the pre-built forwarded
 * content there as a normal message (quote block with provenance header built
 * by the caller). Client-side compose — no dedicated backend forward endpoint.
 */
export function ForwardDialog({
  content,
  sourceChannelId,
  messageCount,
  onClose,
}: {
  /** The already-formatted forward payload (markdown quote block). */
  content: string;
  /** Origin channel — excluded from the target list (forwarding in place is a no-op). */
  sourceChannelId: string;
  messageCount: number;
  onClose: () => void;
}) {
  const [targets, setTargets] = useState<Channel[] | null>(null);
  const [q, setQ] = useState("");
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([listChannels().catch(() => []), listDms().catch(() => [])])
      .then(([chans, dms]) => {
        if (!alive) return;
        const seen = new Set<string>();
        const all = [...chans, ...dms].filter((c) => {
          if (c.channel_id === sourceChannelId || seen.has(c.channel_id)) return false;
          seen.add(c.channel_id);
          return true;
        });
        setTargets(all);
      })
      .catch(() => alive && setTargets([]));
    return () => {
      alive = false;
    };
  }, [sourceChannelId]);

  // DM channels are nameless on the wire — the app labels them by peer_name
  // (same fallback chain as the sidebar), so DMs stay searchable and toast-able.
  const labelOf = (c: Channel) =>
    c.type === "dm" ? c.peer_name || c.name || "Direct Message" : c.name;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!targets) return [];
    if (!term) return targets;
    return targets.filter((c) => labelOf(c).toLowerCase().includes(term));
  }, [targets, q]);

  async function forwardTo(target: Channel) {
    if (sending) return;
    setSending(target.channel_id);
    try {
      await sendMessage(target.channel_id, content);
      toast.success(
        `Forwarded ${messageCount > 1 ? `${messageCount} messages` : "message"} to ${
          target.type === "dm" ? labelOf(target) : `#${labelOf(target)}`
        }`
      );
      onClose();
    } catch (e) {
      // Surface the API's human detail, not raw JSON (e.g. a 403 for a channel
      // the caller can browse but not post to).
      const raw = e instanceof Error ? e.message : String(e);
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { detail?: string }).detail ?? raw;
      } catch {
        /* not JSON — use raw */
      }
      toast.error(detail);
      setSending(null);
    }
  }

  return (
    <Dialog
      title={
        <span className="flex items-center gap-1.5">
          <Forward className="w-4 h-4 text-indigo-400" />
          Forward {messageCount > 1 ? `${messageCount} messages` : "message"}
        </span>
      }
      onClose={onClose}
    >
      <div className="flex items-center gap-2 rounded-lg bg-zinc-950 px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-indigo-500 transition-shadow">
        <Search className="w-3.5 h-3.5 text-zinc-500" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search channels and DMs…"
          className="flex-1 bg-transparent text-base md:text-sm text-zinc-100 outline-none placeholder:text-zinc-400"
        />
      </div>

      <div className="max-h-80 overflow-y-auto">
        {targets === null ? (
          <p className="px-2.5 py-4 text-xs text-zinc-400 text-center">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="px-2.5 py-4 text-xs text-zinc-400 text-center">
            No matching destination
          </p>
        ) : (
          filtered.map((c) => (
            <button
              key={c.channel_id}
              type="button"
              disabled={sending !== null}
              onClick={() => void forwardTo(c)}
              className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-zinc-800 disabled:opacity-50"
            >
              {c.type === "dm" ? (
                <MessageCircle className="w-4 h-4 text-zinc-500 flex-shrink-0" />
              ) : (
                <Hash className="w-4 h-4 text-zinc-500 flex-shrink-0" />
              )}
              <span className="text-sm text-zinc-200 truncate">{labelOf(c)}</span>
              {sending === c.channel_id && (
                <span className="ml-auto text-[11px] text-zinc-400">Sending…</span>
              )}
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
