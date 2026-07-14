import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Radar, Inbox, RefreshCw, Bot as BotIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { getFleet, type FleetApproval, type FleetBot } from "@/api/fleet";
import { listWorkspaces, getPersonalWorkspace } from "@/api/workspaces";
import { useFleetLive } from "./useFleetLive";
import { PermissionCard } from "@/features/chat/PermissionCard";
import { useChatStore } from "@/stores/chatStore";
import { useAuthStore } from "@/stores/authStore";
import type { Message } from "@/types";

// Fleet view (docs/design/FLEET_VIEW.md): the workspace-level mission control.
// Zone A answers "who is waiting on me?" (the caller's approval inbox);
// Zone B answers "what is my fleet doing?" (bot roster with live status/cost).

const POLL_MS = 30_000;

/** DM channels have empty names — render a readable label instead of "#". */
function channelLabel(name: string): string {
  return name.trim() ? `#${name}` : "Direct message";
}

/** Wrap a fleet approval as the Message shape PermissionCard renders. */
function toCardMessage(a: FleetApproval, botName?: string): Message {
  return {
    msg_id: a.message_id,
    sender_id: a.bot_id,
    sender_type: "bot",
    sender_name: botName,
    content: "",
    created_at: a.created_at,
    msg_type: "permission",
    content_data: a.content_data,
  };
}

function StatusChip({ bot }: { bot: FleetBot }) {
  if (!bot.online) {
    return <span className="text-[10px] text-zinc-400">offline</span>;
  }
  if (bot.pending_count > 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200 font-medium">
        waiting approval
      </span>
    );
  }
  if (bot.busy_sessions > 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/15 text-indigo-200 font-medium">
        working
      </span>
    );
  }
  return <span className="text-[10px] text-zinc-400">idle</span>;
}

function BotRow({ bot }: { bot: FleetBot }) {
  const sessions =
    bot.busy_sessions + bot.idle_sessions > 0
      ? `${bot.busy_sessions + bot.idle_sessions} session${
          bot.busy_sessions + bot.idle_sessions === 1 ? "" : "s"
        }${bot.busy_sessions > 0 ? ` · ${bot.busy_sessions} busy` : ""}`
      : null;
  return (
    <div className="flex items-center gap-3 px-2.5 py-2 rounded-md hover:bg-zinc-900">
      <div className="relative flex-shrink-0">
        <Avatar name={bot.bot_name} id={bot.bot_id} size="sm" />
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-zinc-900",
            bot.online ? "bg-emerald-500" : "bg-zinc-600"
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200 truncate">
            {bot.bot_name}
          </span>
          <StatusChip bot={bot} />
        </div>
        {(bot.status_text || sessions) && (
          <p className="text-xs text-zinc-400 truncate mt-0.5">
            {bot.status_emoji && <span className="mr-1">{bot.status_emoji}</span>}
            {bot.status_text}
            {bot.status_text && sessions && <span className="mx-1.5">·</span>}
            {sessions}
          </p>
        )}
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {bot.pending_count > 0 && (
          <span
            className="text-[10px] font-bold bg-amber-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center"
            title={`${bot.pending_count} pending approval${bot.pending_count === 1 ? "" : "s"}`}
          >
            {bot.pending_count}
          </span>
        )}
        {bot.cost_today_usd > 0 && (
          <span className="text-xs text-zinc-400 tabular-nums" title="Cost today (UTC)">
            ${bot.cost_today_usd.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}

export default function FleetPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const {
    workspaces,
    personalWorkspace,
    selectedWorkspaceId,
    setWorkspaces,
    setPersonalWorkspace,
  } = useChatStore();

  // The store is populated by ChatLayout; landing on /fleet directly needs the
  // same bootstrap (workspaces are not persisted).
  useEffect(() => {
    if (workspaces.length > 0) return;
    Promise.all([listWorkspaces(), getPersonalWorkspace().catch(() => null)])
      .then(([ws, personal]) => {
        setWorkspaces(ws);
        if (personal) setPersonalWorkspace(personal);
      })
      .catch(() => {});
  }, [workspaces.length, setWorkspaces, setPersonalWorkspace]);

  const [wsId, setWsId] = useState<string | null>(selectedWorkspaceId);
  const activeWsId =
    wsId ??
    selectedWorkspaceId ??
    personalWorkspace?.workspace_id ??
    workspaces[0]?.workspace_id ??
    null;

  const [approvals, setApprovals] = useState<FleetApproval[]>([]);
  const [bots, setBots] = useState<FleetBot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (workspaceId: string, quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const res = await getFleet(workspaceId);
      setApprovals(res.approvals);
      setBots(res.bots);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the fleet");
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, []);

  // Initial load + poll. P1 keeps this page on simple polling (+ focus refetch);
  // live WS-driven refresh arrives with the P2 `bot_processing` frames.
  useEffect(() => {
    if (!activeWsId) return;
    setLoading(true);
    refresh(activeWsId);
    const t = window.setInterval(() => refresh(activeWsId, true), POLL_MS);
    const onFocus = () => refresh(activeWsId, true);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeWsId, refresh]);

  // Live wire (P2): any relevant WS frame in a fleet channel → quiet refetch.
  // The 30s poll stays as the fallback for signals the WS can't carry.
  const liveChannelIds = useMemo(
    () => [...new Set(bots.map((b) => b.channel_id))],
    [bots]
  );
  useFleetLive(liveChannelIds, () => {
    if (activeWsId) refresh(activeWsId, true);
  });

  const botName = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of bots) m.set(b.bot_id, b.bot_name);
    return m;
  }, [bots]);

  const actionable = approvals.filter((a) => a.actionable);
  const watchOnly = approvals.filter((a) => !a.actionable);

  const botsByChannel = useMemo(() => {
    const groups = new Map<string, { name: string; bots: FleetBot[] }>();
    for (const b of bots) {
      const g = groups.get(b.channel_id) ?? { name: b.channel_name, bots: [] };
      g.bots.push(b);
      groups.set(b.channel_id, g);
    }
    return [...groups.entries()].sort((x, y) =>
      x[1].name.localeCompare(y[1].name)
    );
  }, [bots]);

  const wsOptions = useMemo(() => {
    const list = [...workspaces];
    if (
      personalWorkspace &&
      !list.some((w) => w.workspace_id === personalWorkspace.workspace_id)
    ) {
      list.unshift(personalWorkspace);
    }
    return list;
  }, [workspaces, personalWorkspace]);

  return (
    <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-zinc-800 flex-shrink-0">
        <button
          onClick={() => navigate("/chat")}
          title="Back to chat"
          className="w-8 h-8 max-md:w-11 max-md:h-11 max-md:-ml-2 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Radar className="w-4 h-4 text-indigo-400" />
        <h1 className="text-lg font-semibold">Fleet</h1>
        <div className="ml-auto flex items-center gap-2">
          {wsOptions.length > 1 && (
            <Select
              value={activeWsId ?? ""}
              onChange={(e) => setWsId(e.target.value)}
              aria-label="Workspace"
              className="h-8 py-1 text-xs w-44"
            >
              {wsOptions.map((w) => (
                <option key={w.workspace_id} value={w.workspace_id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <button
            onClick={() => activeWsId && refresh(activeWsId)}
            title="Refresh"
            aria-label="Refresh"
            disabled={refreshing || !activeWsId}
            className="w-8 h-8 max-md:w-11 max-md:h-11 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex items-center justify-center transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-8">
          {loading ? (
            <SurfaceSpinner />
          ) : (
            <>
              {error && (
                <p role="alert" className="text-xs text-red-400">
                  {error}
                </p>
              )}

              {/* ── Zone A: approvals ─────────────────────────────────── */}
              <section>
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Waiting on you
                </h2>
                {actionable.length === 0 ? (
                  <EmptyState
                    icon={Inbox}
                    title="No approvals waiting"
                    hint="When an agent asks for permission, it lands here."
                  />
                ) : (
                  <ul className="space-y-3">
                    {actionable.map((a) => (
                      <li key={a.message_id}>
                        <p className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                          {channelLabel(a.channel_name)}
                        </p>
                        <PermissionCard
                          message={toCardMessage(a, botName.get(a.bot_id))}
                          channelId={a.channel_id}
                          currentUserId={user?.user_id}
                          approverOverride
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {watchOnly.length > 0 && (
                  <div className="mt-5">
                    <h3 className="text-[10px] uppercase tracking-wide text-zinc-400 mb-2">
                      Pending in your channels (not yours to answer)
                    </h3>
                    <ul className="space-y-2">
                      {watchOnly.map((a) => (
                        <li key={a.message_id}>
                          <p className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1">
                            {channelLabel(a.channel_name)}
                          </p>
                          <PermissionCard
                            message={toCardMessage(a, botName.get(a.bot_id))}
                            channelId={a.channel_id}
                            currentUserId={user?.user_id}
                            approverOverride={false}
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>

              {/* ── Zone B: bot roster ────────────────────────────────── */}
              <section>
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Bots
                </h2>
                {botsByChannel.length === 0 ? (
                  <EmptyState
                    icon={BotIcon}
                    title="No bots in this workspace"
                    hint="Add a bot to a channel and it shows up here."
                  />
                ) : (
                  <div className="space-y-5">
                    {botsByChannel.map(([channelId, g]) => (
                      <div key={channelId}>
                        <p className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1 px-2.5">
                          {channelLabel(g.name)}
                        </p>
                        <div>
                          {g.bots.map((b) => (
                            <BotRow key={`${b.bot_id}:${b.channel_id}`} bot={b} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
