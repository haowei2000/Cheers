// Sessions inspector + controller — a ViewBoard where EVERY session is one card
// (channel.sessions.read). The card face keeps just the essentials: which bot,
// status, create time, and an info (ⓘ) toggle; the expanded details hold the
// session id, last-used, mode/config controls and the ACP root set. The card
// matching the composer's selected session is highlighted.
//
// This is the SINGLE home for per-channel session management (the old channel-header
// SessionControlButton was folded in here). Creating a session moved off the bot
// group headers into one "+ New session" button that opens a small dialog: pick a
// bot (only those the caller holds a session_create grant for) + optional working
// directory / extra roots. All mutations refetch the board.
import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Layers, CircleDot, Plus, X, Bot as BotIcon, Info } from "lucide-react";
import {
  getSessionControls,
  createChannelBotSession,
  closeChannelBotSession,
  setSessionMode,
  setSessionConfigOption,
  setSessionAdditionalDirs,
  type SessionControls,
} from "@/api/sessionControl";
import { listChannelMembers } from "@/api/channels";
import { getWorkspaceMeta, type WorkspaceMeta } from "@/api/workspace";
import { Dialog } from "@/components/ui/dialog";
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

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const selCls =
  "rounded bg-zinc-900 border border-zinc-700 px-1 py-0.5 text-[10px] text-zinc-200 outline-none focus:border-indigo-500/60 disabled:opacity-40";

// ── One session = one card ────────────────────────────────────────────────────

function SessionCard({
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
  const [open, setOpen] = useState(false); // ⓘ details
  const [busy, setBusy] = useState(false);

  // The session's effective posture mode: per-session override → the agent's preset default.
  const mode =
    (typeof s.session_config?.permission_mode === "string" && s.session_config.permission_mode) ||
    controls?.current_mode ||
    "";
  const cfgValues = s.session_config?.config_options ?? {};

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

  const botLabel = s.bot_name || s.bot_id.slice(0, 8);

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isSelected
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
      }`}
    >
      {/* Card face: bot · primary chip · status · created · ⓘ · ✕ */}
      <div className="flex items-center gap-2 text-xs">
        <BotIcon className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
        <span className="text-zinc-200 truncate" title={s.bot_id}>
          {botLabel}
        </span>
        <span
          className={`text-[10px] px-1 py-0.5 rounded shrink-0 ${
            s.is_primary ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {s.is_primary ? "primary" : "other"}
        </span>
        <div className="flex-1" />
        <span className="inline-flex items-center gap-1 text-zinc-400 shrink-0">
          <CircleDot className={`w-3 h-3 ${statusColor(s.status)}`} />
          {s.status}
        </span>
        <span
          className="tabular-nums text-zinc-600 shrink-0"
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
            disabled={busy}
            title="Close this session"
            onClick={() => run(() => closeChannelBotSession(channelId, s.bot_id, s.session_id))}
            className="text-zinc-600 hover:text-red-300 disabled:opacity-40 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ⓘ details: id / last used / mode + config controls / root set */}
      {open && (
        <div className="mt-2 border-t border-zinc-800/60 pt-2 space-y-1.5">
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="text-zinc-600 w-12 shrink-0">session</span>
            <span className="font-mono text-zinc-400" title={s.session_id}>
              {s.session_id.slice(0, 8)}
            </span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-zinc-500">
            <span className="text-zinc-600 w-12 shrink-0">last used</span>
            <span className="tabular-nums text-zinc-400">{fmtTime(s.last_used_at)}</span>
            {!canMode && mode && <span className="text-zinc-600">· mode {mode}</span>}
          </div>

          {(canMode || canCfg) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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

          <div className="text-[10px] text-zinc-500">
            <div className="flex items-center gap-1">
              <span className="text-zinc-600 w-12 shrink-0">wd</span>
              <span className="font-mono text-zinc-400 truncate" title={cwd || "connector default"}>
                {cwd || "default"}
              </span>
              {cwd && <span className="text-zinc-700">· immutable</span>}
            </div>
            {dirsDraft === null ? (
              <div className="flex items-start gap-1 mt-0.5">
                <span className="text-zinc-600 w-12 shrink-0">roots</span>
                <span className="font-mono text-zinc-400 flex-1 break-all">
                  {dirs.length ? dirs.join(", ") : "—"}
                </span>
                {canEditRoots && (
                  <button
                    type="button"
                    disabled={busy}
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
                  disabled={busy}
                  onChange={(e) => setDirsDraft(e.target.value)}
                  placeholder="one absolute path per line"
                  rows={Math.max(2, dirsDraft.split("\n").length)}
                  className="w-full rounded bg-zinc-900 border border-zinc-700 px-1 py-0.5 font-mono text-[10px] text-zinc-200 outline-none focus:border-indigo-500/60"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={saveDirs}
                    className="rounded border border-indigo-500/40 bg-indigo-600/15 px-1.5 py-0.5 text-indigo-200 hover:bg-indigo-600/25 disabled:opacity-40"
                  >
                    Save roots
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDirsDraft(null)}
                    className="text-zinc-500 hover:text-zinc-300"
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

// ── New-session dialog ────────────────────────────────────────────────────────

function NewSessionDialog({
  channelId,
  bots,
  onClose,
  onCreated,
}: {
  channelId: string;
  /** Bots the caller may create sessions for: id → label. */
  bots: { id: string; label: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [dirs, setDirs] = useState("");
  const [busy, setBusy] = useState(false);
  // The connector's workspace policy for the selected bot — turns the blind
  // absolute-path inputs into a pick-from-allowed-roots affordance. Best-effort:
  // null (offline connector / older gateway) keeps the plain inputs.
  const [meta, setMeta] = useState<WorkspaceMeta | null>(null);
  useEffect(() => {
    if (!botId) {
      setMeta(null);
      return;
    }
    let alive = true;
    getWorkspaceMeta(channelId, botId)
      .then((m) => alive && setMeta(m))
      .catch(() => alive && setMeta(null));
    return () => {
      alive = false;
    };
  }, [channelId, botId]);

  async function create() {
    if (!botId || busy) return;
    setBusy(true);
    try {
      const trimmedCwd = cwd.trim();
      const additional = dirs
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      await createChannelBotSession(
        channelId,
        botId,
        trimmedCwd || additional.length
          ? { cwd: trimmedCwd || undefined, additional_dirs: additional.length ? additional : undefined }
          : undefined
      );
      toast.success("New session created");
      onCreated();
      onClose();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New session" onClose={onClose} maxWidth="max-w-sm">
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs text-zinc-500">Bot</span>
          <select
            value={botId}
            disabled={busy}
            onChange={(e) => setBotId(e.target.value)}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-indigo-500"
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-zinc-500">Working directory (optional, absolute path)</span>
          <input
            type="text"
            value={cwd}
            disabled={busy}
            placeholder={meta?.default_cwd ?? "/abs/workdir"}
            list="ws-allowed-roots"
            onChange={(e) => setCwd(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-indigo-500"
          />
          {/* Datalist = suggestions, not a constraint: any path under an allowed root works. */}
          <datalist id="ws-allowed-roots">
            {meta?.allowed_roots.map((r) => <option key={r} value={r} />)}
          </datalist>
          {meta && meta.allowed_roots.length > 0 && (
            <span className="block text-[10px] text-zinc-600">
              {meta.backend_may_set_cwd
                ? "Must be inside an allowed root: "
                : "This connector does not let the platform set a cwd. Allowed roots: "}
              {meta.allowed_roots.map((r, i) => (
                <button
                  key={r}
                  type="button"
                  disabled={busy}
                  onClick={() => setCwd(r)}
                  className="font-mono text-zinc-500 hover:text-indigo-300 underline decoration-dotted"
                >
                  {r}
                  {i < meta.allowed_roots.length - 1 ? ", " : ""}
                </button>
              ))}
            </span>
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-zinc-500">Extra roots (optional, one absolute path per line)</span>
          <textarea
            value={dirs}
            disabled={busy}
            rows={2}
            placeholder={"/abs/extra-root"}
            onChange={(e) => setDirs(e.target.value)}
            className="w-full rounded-lg bg-zinc-950 border border-zinc-800 px-2 py-1.5 font-mono text-xs text-zinc-200 outline-none focus:border-indigo-500"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !botId}
            onClick={() => void create()}
            className="inline-flex items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-600/15 px-3 py-1.5 text-xs text-indigo-200 hover:bg-indigo-600/25 disabled:opacity-40"
          >
            <Plus className="w-3 h-3" />
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </Dialog>
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

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[11px] text-zinc-500">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        {creatableBots.length > 0 && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-600/15 px-1.5 py-0.5 text-[10px] text-indigo-200 hover:bg-indigo-600/25"
          >
            <Plus className="w-3 h-3" />
            New session
          </button>
        )}
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-6 text-xs text-zinc-600 flex items-center gap-2">
          <Layers className="w-4 h-4" />
          No sessions yet
        </div>
      ) : (
        sessions.map((s) => (
          <SessionCard
            key={s.session_id}
            s={s}
            selected={selected}
            channelId={ctx.channelId}
            controls={controls[s.bot_id]}
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
