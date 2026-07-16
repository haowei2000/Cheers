// Composer-side session target (docs/arch/SESSION_MODEL.md) — the successor to
// the old native-<select> SessionSwitcher. A chip that shows where the next
// message goes ("Auto" = mention routing → each bot's primary session, or one
// pinned bot+session), opening a popover with every live session grouped by
// bot, plus "New session…" (grant-gated) and a jump to the Sessions board.
//
// Renders whenever the channel has a bot — even with 0–1 sessions — because the
// chip is also where sessions are DISCOVERED and created; hiding it below two
// sessions (the old rule) buried the whole concept.
//
// Data: one `channel.sessions.read` over the socket (all bots, with cwd/
// created_at for good labels), refreshed on every open; falls back to per-bot
// REST when the socket isn't up yet. There is no server push for session-set
// changes, so fetch-on-open is the freshness model.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ArrowRight, Check, ChevronDown, Folder, Layers, LayoutDashboard, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  getSessionControls,
  listChannelBotSessions,
  type SessionControls,
} from "@/api/sessionControl";
import { usePopoverDismiss, PopoverPanel } from "@/components/ui/popover";
import type { SendResourceReq } from "./workbench/fsClient";
import { sessionTag, statusDotColor } from "./sessionLabel";
import { NewSessionDialog } from "./NewSessionDialog";

export interface SwitcherBot {
  botId: string;
  name: string;
}

interface SessionEntry {
  session_id: string;
  bot_id: string;
  bot_name: string;
  is_primary: boolean;
  status: string;
  cwd: string | null;
  /** created_at (socket) or last_used_at (REST fallback) — the tag's time fallback. */
  when: string | null;
}

/** One keyboard-navigable popover row (group headers are skipped by the index). */
type Item =
  | { kind: "auto" }
  | { kind: "session"; entry: SessionEntry }
  | { kind: "new" }
  | { kind: "manage" };

export function SessionChip({
  channelId,
  bots,
  value,
  onChange,
  sendResourceReq,
  onManageSessions,
}: {
  channelId: string;
  bots: SwitcherBot[];
  /** "" = Auto (no session_id sent; mention routing → primary sessions). */
  value: string;
  /** `botId` is the session's owning bot (omitted for Auto) — lets the composer
   *  narrow the model chip to the single bot this pinned session targets. */
  onChange: (sessionId: string, botId?: string) => void;
  sendResourceReq: SendResourceReq;
  /** Open the ViewBoard focused on the Sessions board. */
  onManageSessions: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  // True once a load actually completed (socket read, or every REST call
  // answered) — gates the stale-target reset so a failed/partial fetch can't
  // kick a valid selection back to Auto.
  const [loaded, setLoaded] = useState(false);
  const [controls, setControls] = useState<Record<string, SessionControls>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  usePopoverDismiss(open, close, rootRef);

  // Bots arrive as a fresh array each render; key effects on the id set.
  const botKey = useMemo(() => bots.map((b) => b.botId).join(","), [bots]);
  const botName = useCallback(
    (botId: string, fromRead?: string | null) =>
      fromRead || bots.find((b) => b.botId === botId)?.name || botId.slice(0, 8),
    [bots]
  );

  // A different channel = a different session set; drop the old one before the
  // (re)load effect below fires so stale rows never flash in the popover.
  useEffect(() => {
    setEntries([]);
    setLoaded(false);
    setControls({});
    setNewOpen(false);
  }, [channelId]);

  const load = useCallback(async (): Promise<SessionEntry[] | null> => {
    if (bots.length === 0) {
      setEntries([]);
      return [];
    }
    // Preferred path: one socket read for all bots (carries cwd + created_at).
    try {
      const res = (await sendResourceReq("channel.sessions.read", {
        channel_id: channelId,
      })) as {
        sessions?: Array<{
          session_id: string;
          bot_id: string;
          bot_name?: string | null;
          is_primary: boolean;
          status: string;
          created_at?: string | null;
          workspace?: { cwd?: string | null };
        }>;
      };
      const next = (res.sessions ?? []).map((s) => ({
        session_id: s.session_id,
        bot_id: s.bot_id,
        bot_name: botName(s.bot_id, s.bot_name),
        is_primary: s.is_primary,
        status: s.status,
        cwd: s.workspace?.cwd ?? null,
        when: s.created_at ?? null,
      }));
      setEntries(next);
      setLoaded(true);
      return next;
    } catch {
      /* socket not ready (DISCONNECTED) or older gateway — REST below */
    }
    let complete = true;
    const out = await Promise.all(
      bots.map(async (bot) => {
        try {
          const { sessions } = await listChannelBotSessions(channelId, bot.botId);
          return sessions.map((s) => ({
            session_id: s.session_id,
            bot_id: bot.botId,
            bot_name: bot.name,
            is_primary: s.is_primary,
            status: s.status,
            cwd: null,
            when: s.last_used_at ?? null,
          }));
        } catch {
          complete = false;
          return [] as SessionEntry[];
        }
      })
    );
    const next = out.flat();
    setEntries(next);
    if (complete) setLoaded(true);
    return complete ? next : null;
  }, [channelId, botKey, sendResourceReq]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  // The caller's per-bot grants — fetched lazily on open, only to gate the
  // "New session…" action (fail-closed: an error just hides it).
  const loadControls = useCallback(async () => {
    const pairs = await Promise.all(
      bots.map(async (b) => {
        try {
          return [b.botId, await getSessionControls(channelId, b.botId)] as const;
        } catch {
          return [b.botId, null] as const;
        }
      })
    );
    const next: Record<string, SessionControls> = {};
    for (const [bid, c] of pairs) if (c) next[bid] = c;
    setControls(next);
  }, [channelId, botKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const creatableBots = useMemo(
    () =>
      bots
        .filter((b) => controls[b.botId]?.can_create_session)
        .map((b) => ({ id: b.botId, label: b.name })),
    [bots, controls]
  );

  // If the targeted session vanished (closed elsewhere), fall back to Auto so we
  // never send a stale session_id the backend would reject. Gated on `loaded` so
  // a failed fetch can't cause the reset.
  useEffect(() => {
    if (!value || !loaded) return;
    if (!entries.some((s) => s.session_id === value)) onChange("");
  }, [entries, loaded, value, onChange]);

  const selected = value ? entries.find((s) => s.session_id === value) : undefined;
  const tagOf = (s: SessionEntry) =>
    sessionTag({ is_primary: s.is_primary, session_id: s.session_id, cwd: s.cwd, when: s.when });

  function select(next: string) {
    setOpen(false);
    if (next === value) return;
    const t = next ? entries.find((s) => s.session_id === next) : undefined;
    onChange(next, t?.bot_id);
    if (!next) {
      toast("Default routing restored (@mention → primary session)");
      return;
    }
    if (t) toast.success(`Switched · messages will go directly to @${t.bot_name} (${tagOf(t)})`);
  }

  // Popover rows, grouped by bot in the channel's bot order (unknown bots — a
  // session whose bot left — trail behind, still selectable), primary first.
  const groups = useMemo(() => {
    const order = new Map(bots.map((b, i) => [b.botId, i]));
    const byBot = new Map<string, SessionEntry[]>();
    for (const e of entries) {
      const list = byBot.get(e.bot_id) ?? [];
      list.push(e);
      byBot.set(e.bot_id, list);
    }
    return [...byBot.entries()]
      .sort(
        ([a], [b]) =>
          (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
      )
      .map(([botId, list]) => ({
        botId,
        botName: list[0].bot_name,
        sessions: [...list].sort((a, b) => Number(b.is_primary) - Number(a.is_primary)),
      }));
  }, [entries, bots]);

  // Flat keyboard-navigation list mirroring render order (headers excluded).
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [{ kind: "auto" }];
    for (const g of groups) for (const e of g.sessions) out.push({ kind: "session", entry: e });
    if (creatableBots.length > 0) out.push({ kind: "new" });
    out.push({ kind: "manage" });
    return out;
  }, [groups, creatableBots]);

  function activate(item: Item) {
    if (item.kind === "auto") select("");
    else if (item.kind === "session") select(item.entry.session_id);
    else if (item.kind === "new") {
      setOpen(false);
      setNewOpen(true);
    } else {
      setOpen(false);
      onManageSessions();
    }
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // Fresh data on every open (no push signal exists for session changes).
    void load();
    void loadControls();
    const cur = items.findIndex(
      (it) =>
        (it.kind === "auto" && !value) ||
        (it.kind === "session" && it.entry.session_id === value)
    );
    setActiveIndex(cur === -1 ? 0 : cur);
    setOpen(true);
  }

  // Same keyboard model as the composer's @/​/ picker: arrows wrap, Enter
  // activates, Escape (via usePopoverDismiss) closes. Focus stays on the trigger.
  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) activate(item);
    }
  }

  if (bots.length === 0) return null;

  // Index bookkeeping while rendering the grouped list.
  let rowIndex = 0;
  const rowCls = (i: number, isSelected: boolean) =>
    cn(
      "flex w-full items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors",
      i === activeIndex ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800",
      isSelected && "text-indigo-200"
    );

  return (
    <div ref={rootRef} className="relative inline-flex min-w-0">
      <button
        type="button"
        onClick={toggle}
        onKeyDown={handleKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={
          selected
            ? `Messages will go directly to this session of @${selected.bot_name}, ignoring @mentions`
            : "Session target — Auto routes by @mention to each bot's primary session"
        }
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 max-md:py-2 text-[11px] transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
          selected || open
            ? "bg-indigo-600/15 text-indigo-200"
            : "bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        )}
      >
        {selected ? (
          <ArrowRight className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
        ) : (
          <Layers className={cn("w-3.5 h-3.5 flex-shrink-0", open ? "text-indigo-400" : "text-zinc-500")} />
        )}
        <span className="truncate max-w-[160px]">
          {selected ? `@${selected.bot_name} · ${tagOf(selected)}` : "Auto"}
        </span>
        <ChevronDown className={cn("w-3 h-3 flex-shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <PopoverPanel className="w-72 max-w-[calc(100vw-2rem)] max-h-72 overflow-y-auto p-1">
          {(() => {
            const autoIdx = rowIndex++;
            return (
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  select("");
                }}
                onMouseEnter={() => setActiveIndex(autoIdx)}
                className={rowCls(autoIdx, !value)}
              >
                <Layers className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                <span className="flex-1 min-w-0 truncate">Auto</span>
                <span className="text-[11px] text-zinc-400 flex-shrink-0">@mention → primary</span>
                {!value && <Check className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />}
              </button>
            );
          })()}

          {groups.map((g) => (
            <div key={g.botId}>
              <div className="px-2.5 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                {g.botName}
              </div>
              {g.sessions.map((s) => {
                const idx = rowIndex++;
                const isSel = s.session_id === value;
                return (
                  <button
                    key={s.session_id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    title={s.cwd || s.session_id}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      select(s.session_id);
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={rowCls(idx, isSel)}
                  >
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full flex-shrink-0",
                        statusDotColor(s.status)
                      )}
                    />
                    <span className="flex flex-col flex-1 min-w-0">
                      {/* line 1: tag (primary / time / dir basename) + status */}
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 truncate">{tagOf(s)}</span>
                        <span className="ml-auto text-[11px] text-zinc-400 flex-shrink-0">
                          {s.status}
                        </span>
                      </span>
                      {/* line 2: the working directory (left-truncated, full on hover) */}
                      <span className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-500">
                        <Folder className="w-3 h-3 flex-shrink-0" />
                        <span
                          className="min-w-0 flex-1 truncate font-mono"
                          style={{ direction: "rtl" }}
                        >
                          <span style={{ unicodeBidi: "plaintext" }}>{s.cwd || "default"}</span>
                        </span>
                      </span>
                    </span>
                    {isSel && <Check className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}

          {loaded && entries.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-zinc-400">
              No sessions yet — one is created when a bot first responds.
            </p>
          )}

          <div className="border-t border-zinc-800 my-1" />
          {creatableBots.length > 0 &&
            (() => {
              const idx = rowIndex++;
              return (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    setNewOpen(true);
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={rowCls(idx, false)}
                >
                  <Plus className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                  New session…
                </button>
              );
            })()}
          {(() => {
            const idx = rowIndex++;
            return (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  onManageSessions();
                }}
                onMouseEnter={() => setActiveIndex(idx)}
                className={rowCls(idx, false)}
              >
                <LayoutDashboard className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                Manage sessions…
              </button>
            );
          })()}
        </PopoverPanel>
      )}

      {newOpen && (
        <NewSessionDialog
          channelId={channelId}
          bots={creatableBots}
          onClose={() => setNewOpen(false)}
          onCreated={(created) => {
            // Refresh, then auto-target the new session — the user's next message
            // should go where they just created. The awaited load keeps the
            // stale-target reset from bouncing the fresh id back to Auto.
            void load().then((next) => {
              const entry = next?.find((s) => s.session_id === created.session_id);
              if (entry) onChange(created.session_id, entry.bot_id);
            });
          }}
        />
      )}
    </div>
  );
}
