// Sessions inspector + controller — a ViewBoard grouped BY BOT: each bot is a
// header, its sessions are cards under it (channel.sessions.read). The card face
// shows the session's working directory, a `primary` badge, status, create time,
// and an info (ⓘ) toggle; the expanded details hold the session id, last-used,
// mode/config controls and the ACP root set. The card matching the composer's
// selected session is highlighted.
//
// Drag-to-promote (pointer-based, desktop + touch): drag a non-primary card onto
// its bot's primary card to make it the new primary. While a drag is in flight the
// source dims, the bot's primary card shows a dashed "droppable" hint, and
// hovering it surfaces a "↑ Make primary" pill. (Pointer events, not native HTML5
// DnD, which dropped silently in practice.)
//
// This is the SINGLE home for per-channel session management. Creating a session
// is one "+ New session" button that opens a small dialog: pick a bot (only those
// the caller holds a session_create grant for) + optional working directory /
// extra roots. All mutations refetch the board.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { notify, messageOf } from "@/lib/notify";
import toast from "react-hot-toast";
import { Layers, CircleDot, Plus, X, Bot as BotIcon, Info, Folder, ArrowUp } from "lucide-react";
import {
  getSessionControls,
  closeChannelBotSession,
  setPrimaryChannelBotSession,
  setSessionMode,
  setSessionConfigOption,
  setSessionAdditionalDirs,
  type SessionControls,
} from "@/api/sessionControl";
import { listChannelMembers } from "@/api/channels";
import { NewSessionDialog } from "@/features/chat/NewSessionDialog";
import { statusColor } from "@/features/chat/sessionLabel";
import { bustBotControls } from "@/features/chat/sessionControlsCache";
import { cn } from "@/lib/cn";
import { registerViewBoard, type ViewBoardContext } from "../viewBoard";

interface SessionRow {
  session_id: string;
  bot_id: string;
  /** display_name/username from bot_accounts (null if the bot row is gone). */
  bot_name?: string | null;
  role: string;
  is_primary: boolean;
  status: string;
  created_at?: string;
  last_used_at: string;
  // Per-session overrides: `permission_mode` (from set_mode) + `config_options` (from set_config_option).
  session_config?: { permission_mode?: string; config_options?: Record<string, string> } & Record<string, unknown>;
  // Per-session ACP root set: immutable `cwd` + mutable `additional_dirs`.
  workspace?: { cwd?: string | null; additional_dirs?: string[] };
}
interface SessionsRead {
  channel_id: string;
  sessions: SessionRow[];
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const selCls =
  "rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50";

// ── One session = one card ────────────────────────────────────────────────────

function SessionCard({
  s,
  selected,
  channelId,
  controls,
  refetch,
  busy,
  dragId,
  dropHot,
  onDragPointerDown,
  registerPrimary,
}: {
  s: SessionRow;
  selected: string;
  channelId: string;
  controls?: SessionControls;
  refetch: () => void;
  /** A promote/close is in flight for this bot group (disables card actions). */
  busy: boolean;
  /** session_id currently being dragged within this bot group (null = none). */
  dragId: string | null;
  /** The drag pointer is currently over the primary card (drop would land). */
  dropHot: boolean;
  /** Pointer-down on a non-primary card starts a drag (handled by the group). */
  onDragPointerDown: (e: ReactPointerEvent) => void;
  /** The primary card registers its element so the group can hit-test the drop. */
  registerPrimary: (el: HTMLDivElement | null) => void;
}) {
  const isSelected = selected && s.session_id === selected;
  const [open, setOpen] = useState(false); // ⓘ details
  const [localBusy, setLocalBusy] = useState(false); // per-card actions (mode/config/roots/close)
  // Drag-to-promote is pointer-based (works with touch + reliable across browsers,
  // unlike native HTML5 DnD): a non-primary card is dragged onto its bot's PRIMARY
  // card. The group owns the pointer tracking + hit-test; the card just renders the
  // feedback and starts the drag on pointer-down.
  const canSetPrimary = !!controls?.can_set_primary;
  const canDrag = canSetPrimary && !s.is_primary && !busy;
  const dropTarget = canSetPrimary && s.is_primary;
  const isDragging = dragId === s.session_id;
  const dragActive = dragId != null;

  // The session's effective posture mode: per-session override → the agent's preset default.
  const mode =
    (typeof s.session_config?.permission_mode === "string" && s.session_config.permission_mode) ||
    controls?.current_mode ||
    "";
  const cfgValues = s.session_config?.config_options ?? {};

  const actionBusy = busy || localBusy;
  async function run(fn: () => Promise<void>) {
    setLocalBusy(true);
    try {
      await fn();
      // The composer's session-controls cache (model chip, ComposerBotSettings)
      // has no visibility into board mutations (close/promote/mode/config) —
      // bust it so the next read picks up the new primary/session set instead
      // of routing a change to a stale target.
      bustBotControls(channelId, s.bot_id);
      refetch();
      toast.success("Applied");
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setLocalBusy(false);
    }
  }

  const canMode = !!controls?.can_set_mode && (controls?.allowed_modes.length ?? 0) > 0;
  const canCfg = !!controls?.can_set_config_option && (controls?.config_options.length ?? 0) > 0;
  const canClose = !!controls?.can_close_session && !s.is_primary;

  // ACP root set: immutable `cwd` + mutable `additional_dirs`. Editing the extra
  // roots rides the set_config_option grant (same as the backend gate).
  const cwd = s.workspace?.cwd || null;
  const dirs = s.workspace?.additional_dirs ?? [];
  const canEditRoots = !!controls?.can_set_config_option;
  const [dirsDraft, setDirsDraft] = useState<string | null>(null); // null = not editing
  async function saveDirs() {
    const parsed = (dirsDraft ?? "")
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    await run(async () => {
      await setSessionAdditionalDirs(channelId, s.bot_id, s.session_id, parsed);
      setDirsDraft(null);
    });
  }

  // Working directory shown on the card face (the bot name lives in the group
  // header now). Left-truncated so the meaningful tail (project dir) stays visible.
  const wdLabel = cwd || "default";

  const showHot = dropTarget && dropHot; // pointer over the primary while dragging

  return (
    <div
      ref={dropTarget ? registerPrimary : undefined}
      onPointerDown={canDrag ? onDragPointerDown : undefined}
      title={canDrag ? "Drag onto the primary session to make it primary" : undefined}
      style={canDrag ? { touchAction: "none" } : undefined}
      className={cn(
        "relative rounded-lg border px-3 py-2 transition-[border-color,box-shadow,opacity]",
        isSelected
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700",
        canDrag && (isDragging ? "cursor-grabbing" : "cursor-grab"),
        isDragging && "opacity-40",
        // A card is being dragged → invite the drop on the primary card.
        dropTarget && dragActive && !showHot && "border-dashed border-indigo-500/50",
        showHot && "border-indigo-500/60 bg-indigo-500/10 ring-2 ring-indigo-500/70"
      )}
    >
      {/* Card face: workdir · primary badge · status · created · ⓘ · ✕ */}
      <div className="flex items-center gap-2 text-xs">
        <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300"
          style={{ direction: "rtl" }}
          title={cwd || "connector default"}
        >
          {/* plaintext keeps the path itself LTR while the rtl parent clips the
              LEFT (start) of an overlong path, so the project dir stays visible. */}
          <span style={{ unicodeBidi: "plaintext" }}>{wdLabel}</span>
        </span>
        {s.is_primary && (
          <span className="shrink-0 rounded bg-indigo-500/15 px-1 py-0.5 text-[10px] text-indigo-300">
            primary
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-zinc-400 shrink-0">
          <CircleDot className={`w-3 h-3 ${statusColor(s.status)}`} />
          {s.status}
        </span>
        <span
          className="tabular-nums text-zinc-400 shrink-0"
          title={`created ${fmtTime(s.created_at)}`}
        >
          {fmtTime(s.created_at)}
        </span>
        <button
          type="button"
          title={open ? "Hide details" : "Session details"}
          onClick={() => setOpen((v) => !v)}
          className={`shrink-0 ${open ? "text-indigo-300" : "text-zinc-500 hover:text-zinc-200"}`}
        >
          <Info className="w-3.5 h-3.5" />
        </button>
        {canClose && (
          <button
            type="button"
            disabled={actionBusy}
            title="Close this session"
            onClick={() => run(() => closeChannelBotSession(channelId, s.bot_id, s.session_id))}
            className="text-zinc-500 hover:text-red-300 disabled:opacity-40 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Drop affordance: a pill over the primary card while a drag hovers it. */}
      {showHot && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-medium text-white shadow-lg">
            <ArrowUp className="h-3 w-3" />
            Make primary
          </span>
        </div>
      )}

      {/* ⓘ details: id / last used / mode + config controls / root set */}
      {open && (
        <div className="mt-2 border-t border-zinc-800/60 pt-2 space-y-1.5">
          <div className="flex items-center gap-2 text-[10px] text-zinc-400">
            <span className="w-12 shrink-0">session</span>
            <span className="font-mono text-zinc-200" title={s.session_id}>
              {s.session_id.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-400">
            <span className="w-12 shrink-0">last used</span>
            <span className="tabular-nums text-zinc-200">{fmtTime(s.last_used_at)}</span>
            {!canMode && mode && <span>· mode {mode}</span>}
          </div>

          {(canMode || canCfg) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {canMode && (
                <label className="inline-flex items-center gap-1">
                  <span className="text-[10px] text-zinc-400">mode</span>
                  <select
                    value={controls!.allowed_modes.includes(mode) ? mode : ""}
                    disabled={actionBusy}
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
                      <span className="text-[10px] text-zinc-400">{opt.name}</span>
                      <select
                        value={opt.options.some((o) => o.value === cur) ? cur : ""}
                        disabled={actionBusy}
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

          <div className="text-[10px] text-zinc-400">
            <div className="flex items-center gap-1">
              <span className="w-12 shrink-0">wd</span>
              <span className="font-mono text-zinc-200 truncate" title={cwd || "connector default"}>
                {cwd || "default"}
              </span>
              {cwd && <span>· immutable</span>}
            </div>
            {dirsDraft === null ? (
              <div className="flex items-start gap-1 mt-0.5">
                <span className="text-zinc-400 w-12 shrink-0">roots</span>
                <span className="font-mono text-zinc-400 flex-1 break-all">
                  {dirs.length ? dirs.join(", ") : "—"}
                </span>
                {canEditRoots && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setDirsDraft(dirs.join("\n"))}
                    className="text-indigo-300/70 hover:text-indigo-200 disabled:opacity-40 shrink-0"
                  >
                    edit
                  </button>
                )}
              </div>
            ) : (
              <div className="mt-0.5 flex flex-col gap-1">
                <textarea
                  value={dirsDraft}
                  disabled={actionBusy}
                  onChange={(e) => setDirsDraft(e.target.value)}
                  placeholder="one absolute path per line"
                  rows={Math.max(2, dirsDraft.split("\n").length)}
                  className="w-full rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={saveDirs}
                    className="rounded bg-indigo-600/15 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-600/30 disabled:opacity-40"
                  >
                    Save roots
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setDirsDraft(null)}
                    className="text-zinc-400 hover:text-zinc-200"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── One bot = a header + its session cards ────────────────────────────────────

function BotGroup({
  botId,
  label,
  sessions,
  selected,
  channelId,
  controls,
  refetch,
}: {
  botId: string;
  label: string;
  sessions: SessionRow[];
  selected: string;
  channelId: string;
  controls?: SessionControls;
  refetch: () => void;
}) {
  const primary = sessions.find((s) => s.is_primary);
  const primaryElRef = useRef<HTMLDivElement | null>(null);
  // Pointer-based drag-to-promote (scoped to this bot group): drag a non-primary
  // card and drop it on the bot's PRIMARY card. Native HTML5 DnD proved
  // unreliable (drops silently dropped), so the group owns a pointer drag — it
  // tracks the cursor on `window`, hit-tests the primary card's rect, and on
  // release over it promotes the dragged session. `hot` = cursor is over primary.
  const [drag, setDrag] = useState<{ id: string; hot: boolean } | null>(null);
  const [promoting, setPromoting] = useState(false);

  async function promote(sessionId: string) {
    setPromoting(true);
    try {
      await setPrimaryChannelBotSession(channelId, botId, sessionId);
      bustBotControls(channelId, botId); // composer's controls cache is board-blind
      refetch();
      toast.success("Applied");
    } catch (e) {
      notify.error(messageOf(e));
    } finally {
      setPromoting(false);
    }
  }

  const startDrag = useCallback(
    (sessionId: string, e: ReactPointerEvent) => {
      // Let the ⓘ / ✕ controls keep their clicks — only bare card space drags.
      if ((e.target as HTMLElement).closest("button, select, input, textarea, a")) return;
      if (!primary || sessionId === primary.session_id) return;
      // Capture the pointer so every move/up lands on this element (and bubbles to
      // our window listeners) even if the cursor leaves it; preventDefault stops
      // text selection while dragging. Both mirror the lane-window drag.
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — window listeners still cover the drag */
      }
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      let started = false; // only begins after a small move, so a plain click is inert
      const overPrimary = (x: number, y: number) => {
        const r = primaryElRef.current?.getBoundingClientRect();
        return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      };
      const onMove = (ev: PointerEvent) => {
        if (!started) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
          started = true;
        }
        setDrag({ id: sessionId, hot: overPrimary(ev.clientX, ev.clientY) });
      };
      const onUp = (ev: PointerEvent) => {
        cleanup();
        setDrag(null);
        // Promote when released over the primary card. `started` gates the visual
        // feedback (so a plain click doesn't flash), but the drop itself doesn't
        // require it — a fast flick with no tracked move still lands correctly. A
        // click releases over its own (non-primary) card, so it never promotes.
        if (overPrimary(ev.clientX, ev.clientY)) void promote(sessionId);
      };
      // pointercancel (touch interrupted, capture lost, element unmounts): tear the
      // drag down cleanly — otherwise the listeners leak and the source card stays
      // dimmed forever, and a stale onMove would corrupt the next drag.
      const onCancel = () => {
        cleanup();
        setDrag(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [primary?.session_id, channelId, botId]
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-1">
        <BotIcon className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
        <span className="text-[11px] font-medium text-zinc-300 truncate" title={botId}>
          {label}
        </span>
        <span className="text-[10px] text-zinc-500">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      {sessions.map((s) => (
        <SessionCard
          key={s.session_id}
          s={s}
          selected={selected}
          channelId={channelId}
          controls={controls}
          refetch={refetch}
          busy={promoting}
          dragId={drag?.id ?? null}
          dropHot={!!drag?.hot}
          onDragPointerDown={(e) => startDrag(s.session_id, e)}
          registerPrimary={(el) => {
            primaryElRef.current = el;
          }}
        />
      ))}
    </div>
  );
}

// ── Board body ────────────────────────────────────────────────────────────────

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

  // The bot universe = bots with sessions on the board ∪ bot members of the channel
  // (so a first session can be created from an empty board). id → display label.
  const [memberBots, setMemberBots] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    listChannelMembers(ctx.channelId)
      .then((ms) => {
        if (cancelled) return;
        setMemberBots(
          ms
            .filter((m) => m.member_type === "bot")
            .map((m) => ({ id: m.member_id, label: m.display_name || m.username || m.member_id.slice(0, 8) }))
        );
      })
      .catch(() => setMemberBots([]));
    return () => {
      cancelled = true;
    };
  }, [ctx.channelId]);

  const botIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of sessions) ids.add(s.bot_id);
    for (const b of memberBots) ids.add(b.id);
    return [...ids];
  }, [sessions, memberBots]);
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

  // Bots the caller may create sessions for, labeled (session bot_name → member label → id).
  const creatableBots = useMemo(() => {
    const label = new Map<string, string>();
    for (const b of memberBots) label.set(b.id, b.label);
    for (const s of sessions) if (s.bot_name) label.set(s.bot_id, s.bot_name);
    return botIds
      .filter((id) => controls[id]?.can_create_session)
      .map((id) => ({ id, label: label.get(id) || id.slice(0, 8) }));
  }, [botIds, controls, memberBots, sessions]);

  // Group sessions by bot: one header per bot, primary card first, then the rest
  // newest-first. Group order is alphabetical by bot label for a stable list.
  const groups = useMemo(() => {
    const byBot = new Map<string, SessionRow[]>();
    for (const s of sessions) {
      const arr = byBot.get(s.bot_id);
      if (arr) arr.push(s);
      else byBot.set(s.bot_id, [s]);
    }
    const labelOf = (id: string) =>
      sessions.find((x) => x.bot_id === id && x.bot_name)?.bot_name ||
      memberBots.find((b) => b.id === id)?.label ||
      id.slice(0, 8);
    return [...byBot.entries()]
      .map(([botId, ss]) => ({
        botId,
        label: labelOf(botId),
        sessions: [...ss].sort((a, b) =>
          a.is_primary === b.is_primary
            ? (b.last_used_at || "").localeCompare(a.last_used_at || "")
            : a.is_primary
              ? -1
              : 1
        ),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [sessions, memberBots]);

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="p-2 space-y-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11px] text-zinc-400">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        {creatableBots.length > 0 && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1 rounded bg-indigo-600/15 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-600/30"
          >
            <Plus className="w-3 h-3" />
            New session
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-6 text-xs text-zinc-400 flex items-center gap-2">
          <Layers className="w-4 h-4" />
          No sessions yet
        </div>
      ) : (
        groups.map((g) => (
          <BotGroup
            key={g.botId}
            botId={g.botId}
            label={g.label}
            sessions={g.sessions}
            selected={selected}
            channelId={ctx.channelId}
            controls={controls[g.botId]}
            refetch={refetch}
          />
        ))
      )}

      {dialogOpen && (
        <NewSessionDialog
          channelId={ctx.channelId}
          bots={creatableBots}
          onClose={() => setDialogOpen(false)}
          onCreated={refetch}
        />
      )}
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
