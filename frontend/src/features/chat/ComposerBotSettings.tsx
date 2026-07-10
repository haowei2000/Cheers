import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { SlidersHorizontal, Lock } from "lucide-react";
import {
  getSessionControls,
  listChannelBotSessions,
  setSessionMode,
  setSessionConfigOption,
  type SessionControls,
  type SessionInfo,
} from "@/api/sessionControl";

export interface MentionedBot {
  botId: string;
  name: string;
}

/**
 * Inline mode/config controls for the bot(s) currently @mentioned in the composer —
 * or, when nothing is mentioned, the channel's bots (the parent passes the
 * fallback set, so the controls are reachable without typing a mention)
 * (docs/arch/SESSION_MODEL.md). The CURRENT mode + config values are always shown
 * for any channel member; whether they're editable is gated per-control by the
 * caller's set_mode / set_config_option INITIATE grant. No grant → the value is
 * rendered read-only (disabled, no dropdown affordance) so you can see it but not
 * change it.
 *
 * Values shown are the session's effective ones: a per-session override
 * (session_config) when present, otherwise the bot/agent default. Changes apply to
 * the session the message will route to (the selected one if it's this bot's, else
 * the bot's primary).
 */
export function ComposerBotSettings({
  channelId,
  bots,
  selectedSessionId,
}: {
  channelId: string;
  bots: MentionedBot[];
  selectedSessionId: string;
}) {
  return (
    <>
      {bots.map((b) => (
        <BotInlineSettings
          key={b.botId}
          channelId={channelId}
          bot={b}
          selectedSessionId={selectedSessionId}
        />
      ))}
    </>
  );
}

function BotInlineSettings({
  channelId,
  bot,
  selectedSessionId,
}: {
  channelId: string;
  bot: MentionedBot;
  selectedSessionId: string;
}) {
  const [controls, setControls] = useState<SessionControls | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [busy, setBusy] = useState(false);
  // Optimistic overlay so an applied change shows immediately; cleared when the
  // baseline (target session / controls) changes.
  const [localMode, setLocalMode] = useState<string | null>(null);
  const [localCfg, setLocalCfg] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, s] = await Promise.all([
          getSessionControls(channelId, bot.botId),
          listChannelBotSessions(channelId, bot.botId)
            .then((r) => r.sessions)
            .catch(() => [] as SessionInfo[]),
        ]);
        if (cancelled) return;
        setControls(c);
        setSessions(s);
      } catch {
        /* not a channel member — render nothing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, bot.botId]);

  // The session this message will hit: the selected one if it's this bot's, else
  // its primary. Drives both the displayed current values and the apply target.
  const targetSession = useMemo(
    () =>
      sessions.find((s) => s.session_id === selectedSessionId) ||
      sessions.find((s) => s.is_primary) ||
      sessions[0],
    [sessions, selectedSessionId]
  );
  const target = targetSession?.session_id || "";

  // New baseline → drop optimistic overlays.
  useEffect(() => {
    setLocalMode(null);
    setLocalCfg({});
  }, [target, controls]);

  if (!controls) return null;
  const hasMode = controls.allowed_modes.length > 0;
  if (!hasMode && controls.config_options.length === 0) return null;

  async function apply(fn: () => Promise<void>, optimistic: () => void) {
    setBusy(true);
    optimistic();
    try {
      await fn();
      toast.success("Applied");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  const selBase = "rounded border px-1 py-0.5 text-[11px] outline-none";
  const selOn = `${selBase} bg-zinc-900 border-zinc-600 text-zinc-200 focus:border-indigo-500/60 disabled:opacity-50`;
  // Read-only look: muted, no caret, not-allowed cursor — "you can see it, not change it".
  const selOff = `${selBase} bg-zinc-900/30 border-zinc-800 text-zinc-400 cursor-not-allowed appearance-none`;

  // Effective current values: optimistic overlay → session override → bot/agent default.
  const mode = localMode ?? targetSession?.session_config?.permission_mode ?? controls.current_mode ?? "";
  const canMode = controls.can_set_mode && !!target;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-zinc-800/60 px-2 py-1">
      <span className="inline-flex items-center gap-1">
        <SlidersHorizontal className="w-3 h-3 text-zinc-500" />
        <span className="text-[11px] font-medium text-zinc-300">@{bot.name}</span>
      </span>

      {hasMode && (
        <span
          className="inline-flex items-center gap-1"
          title={controls.can_set_mode ? "Session mode" : "Session mode — read-only (no permission)"}
        >
          <span className="text-[10px] text-zinc-500">mode</span>
          {!controls.can_set_mode && <Lock className="w-2.5 h-2.5 text-zinc-600" />}
          <select
            value={mode}
            disabled={!canMode || busy}
            onChange={(e) => {
              const v = e.target.value;
              apply(
                () => setSessionMode(channelId, bot.botId, target, v),
                () => setLocalMode(v)
              );
            }}
            className={canMode ? selOn : selOff}
          >
            {!mode && <option value="">—</option>}
            {!controls.allowed_modes.includes(mode) && mode && <option value={mode}>{mode}</option>}
            {controls.allowed_modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </span>
      )}

      {controls.config_options.map((opt) => {
        const canCfg = controls.can_set_config_option && !!target;
        const cur =
          localCfg[opt.id] ??
          targetSession?.session_config?.config_options?.[opt.id] ??
          opt.currentValue ??
          "";
        return (
          <span
            key={opt.id}
            className="inline-flex items-center gap-1"
            title={canCfg ? opt.name : `${opt.name} — read-only (no permission)`}
          >
            <span className="text-[10px] text-zinc-500">{opt.name}</span>
            {!controls.can_set_config_option && <Lock className="w-2.5 h-2.5 text-zinc-600" />}
            <select
              value={cur}
              disabled={!canCfg || busy}
              onChange={(e) => {
                const v = e.target.value;
                apply(
                  () => setSessionConfigOption(channelId, bot.botId, target, opt.id, v),
                  () => setLocalCfg((c) => ({ ...c, [opt.id]: v }))
                );
              }}
              className={canCfg ? selOn : selOff}
            >
              {!cur && <option value="">—</option>}
              {!opt.options.some((o) => o.value === cur) && cur && <option value={cur}>{cur}</option>}
              {opt.options.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.name}
                </option>
              ))}
            </select>
          </span>
        );
      })}
    </span>
  );
}
