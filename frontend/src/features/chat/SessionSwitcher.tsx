import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Layers, ArrowRight } from "lucide-react";
import { listChannelBotSessions, type SessionInfo } from "@/api/sessionControl";
import { sessionTag } from "@/features/chat/sessionLabel";

export interface SwitcherBot {
  botId: string;
  name: string;
}

interface BotSessions {
  bot: SwitcherBot;
  sessions: SessionInfo[];
}

/**
 * Composer-side session picker (docs/arch/SESSION_MODEL.md). When a channel holds
 * more than one live session across its bots, let the sender target a specific one
 * for the next message. `value === ""` means "Auto": no `session_id` is sent, so the
 * backend falls back to mention-based routing into each bot's primary session.
 *
 * Selecting a specific session passes its `session_id`, which on the server forces
 * that one bot+session and overrides mention routing. Renders nothing when there is
 * no real choice (< 2 sessions total) — the switcher only appears once it matters.
 */
export function SessionSwitcher({
  channelId,
  bots,
  value,
  onChange,
}: {
  channelId: string;
  bots: SwitcherBot[];
  value: string;
  onChange: (sessionId: string) => void;
}) {
  const [grouped, setGrouped] = useState<BotSessions[]>([]);

  // Bots arrive as a fresh array each render; key the effect on the id set so we
  // don't refetch on every parent re-render.
  const botKey = useMemo(
    () => bots.map((b) => b.botId).join(","),
    [bots]
  );

  const load = useCallback(async () => {
    if (bots.length === 0) {
      setGrouped([]);
      return;
    }
    const out = await Promise.all(
      bots.map(async (bot) => {
        try {
          const { sessions } = await listChannelBotSessions(channelId, bot.botId);
          return { bot, sessions } as BotSessions;
        } catch {
          return { bot, sessions: [] } as BotSessions;
        }
      })
    );
    setGrouped(out.filter((g) => g.sessions.length > 0));
  }, [channelId, botKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  const total = grouped.reduce((n, g) => n + g.sessions.length, 0);

  // Resolve which bot a session_id belongs to — the native <select> only shows the
  // session label when collapsed, so we surface the bot name ourselves.
  const targetFor = useCallback(
    (sessionId: string) => {
      for (const g of grouped) {
        const s = g.sessions.find((x) => x.session_id === sessionId);
        if (s) {
          return {
            bot: g.bot,
            label: sessionTag({
              is_primary: s.is_primary,
              session_id: s.session_id,
              when: s.last_used_at,
            }),
          };
        }
      }
      return null;
    },
    [grouped]
  );
  const selected = value ? targetFor(value) : null;

  function handleSelect(next: string) {
    onChange(next);
    if (!next) {
      toast("Default routing restored (@mention → primary session)");
      return;
    }
    const t = targetFor(next);
    if (t) toast.success(`Switched · messages will go directly to @${t.bot.name} (${t.label})`);
  }

  // If the targeted session vanished (closed elsewhere, or channel changed), fall
  // back to Auto so we never send a stale session_id the backend would reject.
  useEffect(() => {
    if (!value) return;
    const stillThere = grouped.some((g) =>
      g.sessions.some((s) => s.session_id === value)
    );
    if (grouped.length > 0 && !stillThere) onChange("");
  }, [grouped, value, onChange]);

  // No genuine choice → stay out of the way.
  if (total < 2) return null;

  return (
    <div className="inline-flex items-center gap-2">
      <label
        className={
          "inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] " +
          (selected
            ? "border-indigo-500/50 bg-indigo-600/10 text-indigo-200"
            : "border-zinc-700 bg-zinc-800/60 text-zinc-400")
        }
      >
        <Layers
          className={
            "w-3.5 h-3.5 " + (selected ? "text-indigo-400" : "text-zinc-500")
          }
        />
        <span className="sr-only">Target session</span>
        <select
          value={value}
          onFocus={() => void load()}
          onMouseDown={() => void load()}
          onChange={(e) => handleSelect(e.target.value)}
          className="bg-transparent text-[11px] text-inherit outline-none max-w-[180px]"
        >
          <option value="">Auto · primary / @mention</option>
          {grouped.map((g) => (
            <optgroup key={g.bot.botId} label={g.bot.name}>
              {g.sessions.map((s) => (
                <option key={s.session_id} value={s.session_id} title={s.session_id}>
                  {`${sessionTag({
                    is_primary: s.is_primary,
                    session_id: s.session_id,
                    when: s.last_used_at,
                  })} (${s.status})`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {/* Make the routing target unmistakable: this message goes straight to one bot. */}
      {selected && (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-indigo-300"
          title={`Messages will go directly to this session of @${selected.bot.name}, ignoring @mentions`}
        >
          <ArrowRight className="w-3 h-3" />
          <span className="font-medium">@{selected.bot.name}</span>
        </span>
      )}
    </div>
  );
}
