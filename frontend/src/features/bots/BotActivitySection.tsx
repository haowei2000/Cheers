import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { RefreshCw } from "lucide-react";
import { getBotAcpEvents, type AcpEventRow } from "@/api/bots";

const homeCls: Record<string, string> = {
  cheers: "bg-indigo-950/60 border-indigo-900 text-indigo-200",
  observe: "bg-zinc-800 border-zinc-700 text-zinc-300",
  connector: "bg-amber-950/50 border-amber-900 text-amber-200",
  agent: "bg-zinc-800 border-zinc-700 text-zinc-400",
};

const shortName = (n: string) =>
  n.replace(/^session\/update:/, "").replace(/^session\//, "");
const time = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
};

/**
 * Read-only ACP event timeline (docs/arch/ACP_EVENT_TAXONOMY.md, Phase 5) — every
 * event the bot emitted, from acp_event_log, tagged by its registry home.
 */
export function BotActivitySection({ botId }: { botId: string }) {
  const [events, setEvents] = useState<AcpEventRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents((await getBotAcpEvents(botId, 80)).events);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="rounded-xl bg-zinc-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-zinc-300">Recent ACP activity</span>
        <span className="text-[11px] text-zinc-400">
          every event the bot emitted (newest first)
        </span>
        <button
          type="button"
          onClick={load}
          className="ml-auto text-zinc-500 hover:text-zinc-300"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {events.length === 0 ? (
        <p className="text-[11px] text-zinc-400">
          {loading ? "Loading…" : "No events recorded yet — prompt the bot to see its activity."}
        </p>
      ) : (
        <div className="max-h-56 overflow-y-auto divide-y divide-zinc-800/70">
          {events.map((e, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-[11px]">
              <span className="text-zinc-400 tabular-nums w-20 shrink-0">{time(e.created_at)}</span>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 border text-[10px] ${homeCls[e.home] ?? homeCls.observe}`}
                title={`home: ${e.home || "unclassified"}`}
              >
                {e.home || "?"}
              </span>
              <code className="text-zinc-300 truncate">{shortName(e.name)}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
