// Sessions inspector + controller — a ViewBoard listing every live session bound to
// the channel (channel.sessions.read), grouped by bot: primary + "other", with status,
// mode and (gated) inline controls. The row matching the composer's selected session is
// highlighted.
//
// This is the SINGLE home for per-channel session management (the old channel-header
// SessionControlButton was folded in here): for each bot the caller has an INITIATE
// grant on, every session row gets a mode dropdown (set_mode), a config dropdown per
// advertised option (set_config_option) and a close ✕ for non-primary sessions
// (session_close); each bot gets a "+ New session" button (can_create_session). All
// mutations refetch the board. Read-only ids/values render as inert text.
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Layers, CircleDot, Plus, X } from "lucide-react";
import {
  getSessionControls,
  createChannelBotSession,
  closeChannelBotSession,
  setSessionMode,
  setSessionConfigOption,
  type SessionControls,
} from "@/api/sessionControl";
import { registerViewBoard, type ViewBoardContext } from "../viewBoard";

interface SessionRow {
  session_id: string;
  bot_id: string;
  role: string;
  is_primary: boolean;
  status: string;
  last_used_at: string;
  // Per-session overrides: `permission_mode` (from set_mode) + `config_options` (from set_config_option).
  session_config?: { permission_mode?: string; config_options?: Record<string, string> } & Record<string, unknown>;
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

const selCls =
  "rounded bg-zinc-900 border border-zinc-700 px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-indigo-500/60 disabled:opacity-40";

function SessionRowView({
  s,
  selected,
  channelId,
  controls,
  refetch,
}: {
  s: SessionRow;
  selected: string;
  channelId: string;
  controls?: SessionControls;
  refetch: () => void;
}) {
  const isSelected = selected && s.session_id === selected;
  // The session's effective posture mode: per-session override → the agent's preset default.
  const mode =
    (typeof s.session_config?.permission_mode === "string" && s.session_config.permission_mode) ||
    controls?.current_mode ||
    "";
  const cfgValues = s.session_config?.config_options ?? {};
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      refetch();
      toast.success("Applied");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  const canMode = !!controls?.can_set_mode && (controls?.allowed_modes.length ?? 0) > 0;
  const canCfg = !!controls?.can_set_config_option && (controls?.config_options.length ?? 0) > 0;
  const canClose = !!controls?.can_close_session && !s.is_primary;
  const hasControls = canMode || canCfg;

  return (
    <div className={`px-3 py-1.5 ${isSelected ? "bg-emerald-500/10" : "hover:bg-zinc-800/40"}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="font-mono text-zinc-200">{s.session_id.slice(0, 8)}</span>
        <span
          className={`text-[10px] px-1 py-0.5 rounded ${
            s.is_primary ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {s.is_primary ? "primary" : "other"}
        </span>
        {!hasControls && mode && <span className="text-[10px] text-zinc-500">{mode}</span>}
        <div className="flex-1" />
        <span className="inline-flex items-center gap-1 text-zinc-400">
          <CircleDot className={`w-3 h-3 ${statusColor(s.status)}`} />
          {s.status}
        </span>
        <span className="tabular-nums text-zinc-600 w-24 text-right">{fmtTime(s.last_used_at)}</span>
        {canClose && (
          <button
            type="button"
            disabled={busy}
            title="Close this session"
            onClick={() =>
              run(() => closeChannelBotSession(channelId, s.bot_id, s.session_id))
            }
            className="text-zinc-600 hover:text-red-300 disabled:opacity-40"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {hasControls && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-1">
          {canMode && (
            <label className="inline-flex items-center gap-1">
              <span className="text-[10px] text-zinc-500">mode</span>
              <select
                value={controls!.allowed_modes.includes(mode) ? mode : ""}
                disabled={busy}
                onChange={(e) =>
                  e.target.value &&
                  run(() => setSessionMode(channelId, s.bot_id, s.session_id, e.target.value))
                }
                className={selCls}
              >
                {!controls!.allowed_modes.includes(mode) && (
                  <option value="">{mode || "—"}</option>
                )}
                {controls!.allowed_modes.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canCfg &&
            controls!.config_options.map((opt) => {
              const cur = cfgValues[opt.id] ?? opt.currentValue ?? "";
              return (
                <label key={opt.id} className="inline-flex items-center gap-1">
                  <span className="text-[10px] text-zinc-500">{opt.name}</span>
                  <select
                    value={opt.options.some((o) => o.value === cur) ? cur : ""}
                    disabled={busy}
                    onChange={(e) =>
                      e.target.value &&
                      run(() =>
                        setSessionConfigOption(channelId, s.bot_id, s.session_id, opt.id, e.target.value)
                      )
                    }
                    className={selCls}
                  >
                    {!opt.options.some((o) => o.value === cur) && (
                      <option value="">{cur || "—"}</option>
                    )}
                    {opt.options.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
        </div>
      )}
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

  // The caller's resolved controls per bot (create/close + mode/config vocabulary),
  // same gate as the old header control. Fail-closed: an error → no controls.
  const [controls, setControls] = useState<Record<string, SessionControls>>({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      botIds.map(async (bid) => {
        try {
          return [bid, await getSessionControls(ctx.channelId, bid)] as const;
        } catch {
          return [bid, null] as const;
        }
      })
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, SessionControls> = {};
      for (const [bid, c] of pairs) if (c) next[bid] = c;
      setControls(next);
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
            {controls[botId]?.can_create_session && (
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
            <SessionRowView
              key={s.session_id}
              s={s}
              selected={selected}
              channelId={ctx.channelId}
              controls={controls[botId]}
              refetch={refetch}
            />
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
