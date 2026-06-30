// Sessions inspector — a ViewBoard listing every live session bound to the channel
// (channel.sessions.read), grouped by bot: primary + "other", with status + mode.
// The row matching the composer's selected session is highlighted.
//
// Lightweight control (the ViewBoard kind that "acts on" rather than authors): each
// bot the caller can create on gets a "+ New session" button (gated by the same
// can_create_session as the header session control; reuses createChannelBotSession).
// All ids/values render as inert text.
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Layers, CircleDot, Plus } from "lucide-react";
import {
  getSessionControls,
  createChannelBotSession,
} from "@/api/sessionControl";
import { registerViewBoard, type ViewBoardContext } from "../viewBoard";

interface SessionRow {
  session_id: string;
  bot_id: string;
  role: string;
  is_primary: boolean;
  status: string;
  last_used_at: string;
  session_config?: { mode?: string } & Record<string, unknown>;
}
interface SessionsRead {
  channel_id: string;
  sessions: SessionRow[];
}

function statusColor(s: string): string {
  switch (s) {
    case "active":
    case "busy":
      return "text-emerald-500";
    case "idle":
      return "text-zinc-500";
    case "paused":
      return "text-amber-400";
    case "error":
    case "revoked":
    case "expired":
      return "text-red-400";
    default:
      return "text-zinc-600";
  }
}

function fmtTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function SessionRowView({ s, selected }: { s: SessionRow; selected: string }) {
  const isSelected = selected && s.session_id === selected;
  const mode = typeof s.session_config?.mode === "string" ? s.session_config.mode : null;
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 text-xs ${
        isSelected ? "bg-emerald-500/10" : "hover:bg-zinc-800/40"
      }`}
    >
      <span className="font-mono text-zinc-200">{s.session_id.slice(0, 8)}</span>
      <span
        className={`text-[10px] px-1 py-0.5 rounded ${
          s.is_primary ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"
        }`}
      >
        {s.is_primary ? "primary" : "other"}
      </span>
      {mode && <span className="text-[10px] text-zinc-500">{mode}</span>}
      <div className="flex-1" />
      <span className="inline-flex items-center gap-1 text-zinc-400">
        <CircleDot className={`w-3 h-3 ${statusColor(s.status)}`} />
        {s.status}
      </span>
      <span className="tabular-nums text-zinc-600 w-24 text-right">{fmtTime(s.last_used_at)}</span>
    </div>
  );
}

function SessionsBody({
  data,
  ctx,
  refetch,
}: {
  data: SessionsRead;
  ctx: ViewBoardContext;
  refetch: () => void;
}) {
  const sessions = data.sessions ?? [];
  const selected = ctx.selectedSessionId || "";

  // Group sessions by bot (primary first within each bot — the read verb already
  // orders by bot, then primary, then last-used).
  const byBot = useMemo(() => {
    const m = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const arr = m.get(s.bot_id) ?? [];
      arr.push(s);
      m.set(s.bot_id, arr);
    }
    return m;
  }, [sessions]);
  const botIds = useMemo(() => [...byBot.keys()], [byBot]);
  const botKey = botIds.join(",");

  // Which bots the caller may create a session on (same gate as the header control).
  const [canCreate, setCanCreate] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      botIds.map(async (bid) => {
        try {
          const c = await getSessionControls(ctx.channelId, bid);
          return [bid, c.can_create_session] as const;
        } catch {
          return [bid, false] as const;
        }
      })
    ).then((pairs) => {
      if (!cancelled) setCanCreate(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.channelId, botKey]);

  const [busyBot, setBusyBot] = useState<string | null>(null);
  async function createFor(botId: string) {
    setBusyBot(botId);
    try {
      await createChannelBotSession(ctx.channelId, botId);
      refetch();
      toast.success("New session created");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyBot(null);
    }
  }

  if (sessions.length === 0) {
    return (
      <div className="px-3 py-6 text-xs text-zinc-600 flex items-center gap-2">
        <Layers className="w-4 h-4" />
        No sessions yet
      </div>
    );
  }

  return (
    <div className="py-1">
      {botIds.map((botId) => (
        <div key={botId} className="mb-2">
          <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-zinc-500 border-b border-zinc-800/60">
            <span className="font-mono text-zinc-400 truncate">{botId.slice(0, 8)}</span>
            <span className="text-zinc-600">· {byBot.get(botId)!.length} session{byBot.get(botId)!.length === 1 ? "" : "s"}</span>
            <div className="flex-1" />
            {canCreate[botId] && (
              <button
                type="button"
                disabled={busyBot === botId}
                onClick={() => createFor(botId)}
                className="inline-flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-600/15 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-600/25 disabled:opacity-40"
              >
                <Plus className="w-3 h-3" />
                {busyBot === botId ? "…" : "New session"}
              </button>
            )}
          </div>
          {byBot.get(botId)!.map((s) => (
            <SessionRowView key={s.session_id} s={s} selected={selected} />
          ))}
        </div>
      ))}
    </div>
  );
}

registerViewBoard<SessionsRead>({
  id: "sessions",
  title: "Sessions",
  icon: Layers,
  verb: "channel.sessions.read",
  sessionScoped: false,
  makeParams: (ctx) => ({ channel_id: ctx.channelId }),
  render: (data, ctx, refetch) => <SessionsBody data={data} ctx={ctx} refetch={refetch} />,
});
