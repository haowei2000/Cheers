import { IconButton } from "@/components/ui/icon-button";
import { useCallback, useEffect, useState } from "react";
import { notify, messageOf } from "@/lib/notify";
import { RefreshCw } from "lucide-react";
import { getBotAcpEvents, type AcpEventRow } from "@/api/bots";
import { ItemList, WorkbenchItem } from "@/components/ui/item";

const homeCls: Record<string, string> = {
  cheers: "bg-indigo-950/60 border-indigo-900 text-indigo-200",
  observe: "bg-zinc-800 border-zinc-700 text-zinc-200",
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
      notify.error(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="rounded-sm bg-zinc-950/40 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-compact font-medium text-zinc-200">Recent activity</span>
        <span className="text-compact text-zinc-400">
          every event the bot emitted (newest first)
        </span>
        <IconButton
          label="Refresh bot activity"
          onClick={load}
          className="ml-auto text-zinc-100 hover:text-zinc-50"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </IconButton>
      </div>
      {events.length === 0 ? (
        <p className="text-compact text-zinc-400">
          {loading ? "Loading…" : "No events recorded yet — prompt the bot to see its activity."}
        </p>
      ) : (
        <ItemList presentationLevel="medium" controlSize="regular" className="max-h-56 overflow-y-auto pr-1">
          {events.map((e, i) => (
            <WorkbenchItem key={i} title={<code>{shortName(e.name)}</code>} trailing={<span className="text-compact tabular-nums text-zinc-400">{time(e.created_at)}</span>}
              status={<span
                className={`shrink-0 rounded-sm px-2 py-1 text-minimal ${homeCls[e.home] ?? homeCls.observe}`}
                title={`home: ${e.home || "unclassified"}`}
              >
                {e.home || "?"}
              </span>}
              presentationLevel="medium" className="border-0 bg-zinc-950/30" />
          ))}
        </ItemList>
      )}
    </div>
  );
}
