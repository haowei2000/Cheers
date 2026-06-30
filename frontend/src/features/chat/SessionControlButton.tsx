import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { SlidersHorizontal, Plus, X } from "lucide-react";
import { listChannelMembers } from "@/api/channels";
import {
  getSessionControls,
  listChannelBotSessions,
  createChannelBotSession,
  closeChannelBotSession,
  setSessionMode,
  setSessionConfigOption,
  type SessionControls,
  type SessionInfo,
} from "@/api/sessionControl";

type GrantedBot = {
  botId: string;
  name: string;
  controls: SessionControls;
};

/**
 * Channel-header control (docs/arch/SESSION_MODEL.md): for each bot in the channel
 * the caller has an INITIATE grant on (set_mode / set_config_option), let them pick
 * a session (primary / other) and change ITS mode/config. Renders nothing when the
 * caller has no grant — visibility mirrors the server's fail-closed gate.
 */
export function SessionControlButton({ channelId }: { channelId: string }) {
  const [bots, setBots] = useState<GrantedBot[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const members = await listChannelMembers(channelId);
        const botMembers = members.filter((m) => m.member_type === "bot");
        const resolved = await Promise.all(
          botMembers.map(async (m) => {
            try {
              const controls = await getSessionControls(channelId, m.member_id);
              if (
                !controls.can_set_mode &&
                !controls.can_set_config_option &&
                !controls.can_create_session &&
                !controls.can_close_session
              )
                return null;
              return {
                botId: m.member_id,
                name: m.display_name || m.username || m.member_id.slice(0, 8),
                controls,
              } as GrantedBot;
            } catch {
              return null;
            }
          })
        );
        if (!cancelled) setBots(resolved.filter((b): b is GrantedBot => b !== null));
      } catch {
        /* not a member / no bots — render nothing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (bots.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Agent session mode / config"
        className="flex items-center justify-center w-7 h-7 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800"
      >
        <SlidersHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl space-y-3">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Agent session</p>
          {bots.map((b) => (
            <BotSessionControls key={b.botId} channelId={channelId} bot={b} />
          ))}
        </div>
      )}
    </div>
  );
}

function BotSessionControls({ channelId, bot }: { channelId: string; bot: GrantedBot }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [target, setTarget] = useState<string>(""); // session_id; "" until loaded
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions } = await listChannelBotSessions(channelId, bot.botId);
      setSessions(sessions);
      setTarget((cur) => cur || sessions.find((s) => s.is_primary)?.session_id || sessions[0]?.session_id || "");
    } catch (e) {
      toast.error(String(e));
    }
  }, [channelId, bot.botId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      toast.success("Applied");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  const sel =
    "rounded-md bg-zinc-800 border border-zinc-700 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-indigo-500/60 disabled:opacity-40";

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-zinc-200 truncate flex-1">{bot.name}</span>
        {bot.controls.can_create_session && (
          <button
            type="button"
            disabled={busy}
            title="New session"
            onClick={() =>
              run(async () => {
                const s = await createChannelBotSession(channelId, bot.botId);
                await loadSessions();
                setTarget(s.session_id);
              })
            }
            className="inline-flex items-center gap-0.5 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
          >
            <Plus className="w-3 h-3" />
            new
          </button>
        )}
      </div>

      <label className="flex items-center gap-1.5">
        <span className="text-[11px] text-zinc-500 w-12">session</span>
        <select value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)} className={`${sel} flex-1`}>
          {sessions.map((s) => (
            <option key={s.session_id} value={s.session_id}>
              {s.is_primary ? "primary" : `other · ${s.session_id.slice(0, 8)}`} ({s.status})
            </option>
          ))}
        </select>
        {bot.controls.can_close_session && !sessions.find((s) => s.session_id === target)?.is_primary && (
          <button
            type="button"
            disabled={busy || !target}
            title="Close this session"
            onClick={() =>
              run(async () => {
                await closeChannelBotSession(channelId, bot.botId, target);
                await loadSessions();
                setTarget("");
              })
            }
            className="text-zinc-600 hover:text-red-300 disabled:opacity-40"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </label>

      {bot.controls.can_set_mode && bot.controls.allowed_modes.length > 0 && (
        <label className="flex items-center gap-1.5">
          <span className="text-[11px] text-zinc-500 w-12">mode</span>
          <select
            defaultValue=""
            disabled={busy || !target}
            onChange={(e) => e.target.value && run(() => setSessionMode(channelId, bot.botId, target, e.target.value))}
            className={`${sel} flex-1`}
          >
            <option value="">set mode…</option>
            {bot.controls.allowed_modes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}

      {bot.controls.can_set_config_option &&
        bot.controls.config_options.map((opt) => (
          <label key={opt.id} className="flex items-center gap-1.5">
            <span className="text-[11px] text-zinc-500 w-12 truncate" title={opt.name}>
              {opt.name}
            </span>
            <select
              defaultValue=""
              disabled={busy || !target}
              onChange={(e) =>
                e.target.value &&
                run(() => setSessionConfigOption(channelId, bot.botId, target, opt.id, e.target.value))
              }
              className={`${sel} flex-1`}
            >
              <option value="">set…</option>
              {opt.options.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
        ))}
    </div>
  );
}
