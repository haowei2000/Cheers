import { Button as UiButton } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Radar,
  Inbox,
  RefreshCw,
  Bot as BotIcon,
  Wand2,
  KeyRound,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ItemRow } from "@/components/ui/item";
import { getFleet, type FleetApproval, type FleetBot } from "@/api/fleet";
import { listWorkspaces, getPersonalWorkspace } from "@/api/workspaces";
import { listBots, issueBotToken, type IssuedToken } from "@/api/bots";
import { listChannels } from "@/api/channels";
import { useFleetLive } from "./useFleetLive";
import { useChatStore } from "@/stores/chatStore";
import { useActivityUiStore } from "@/stores/activityUiStore";
import { BotOnboardingWizard } from "@/features/bots/BotOnboardingWizard";
import { BotDetailPanel, CopyButton } from "@/features/bots/BotDetailPanel";
import type { BotItem, Channel } from "@/types";

// Fleet view: workspace bot roster + create/manage (detail + token).
// Approvals live in Activity (`docs/arch/CLIENT_NAV_IA.md`); this page deep-links.

const POLL_MS = 30_000;

/** DM channels have empty names — render a readable label instead of "#". */
function channelLabel(name: string): string {
  return name.trim() ? `#${name}` : "Direct message";
}

function StatusChip({ bot }: { bot: FleetBot }) {
  if (!bot.online) {
    return <span className="text-[10px] text-zinc-400">offline</span>;
  }
  if (bot.pending_count > 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-amber-900/40 text-amber-200 font-medium">
        waiting approval
      </span>
    );
  }
  if (bot.busy_sessions > 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-600/15 text-indigo-200 font-medium">
        working
      </span>
    );
  }
  return <span className="text-[10px] text-zinc-400">idle</span>;
}

function BotRow({
  bot,
  onSelect,
}: {
  bot: FleetBot;
  onSelect: () => void;
}) {
  const sessions =
    bot.busy_sessions + bot.idle_sessions > 0
      ? `${bot.busy_sessions + bot.idle_sessions} session${
          bot.busy_sessions + bot.idle_sessions === 1 ? "" : "s"
        }${bot.busy_sessions > 0 ? ` · ${bot.busy_sessions} busy` : ""}`
      : null;
  return (
    <ItemRow
      kind="operations"
      onClick={onSelect}
      title={bot.bot_name}
      leading={<div className="relative flex-shrink-0">
        <Avatar name={bot.bot_name} id={bot.bot_id} size="sm" />
        <span
          className={cn(
            "absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-zinc-900",
            bot.online ? "bg-emerald-500" : "bg-zinc-600"
          )}
        />
      </div>}
      status={<StatusChip bot={bot} />}
      subtitle={(bot.status_text || sessions) ? (
        <>
            {bot.status_emoji && <span className="mr-1">{bot.status_emoji}</span>}
            {bot.status_text}
            {bot.status_text && sessions && <span className="mx-1.5">·</span>}
            {sessions}
        </>
      ) : undefined}
      criticalStatus={bot.pending_count > 0 ? (
          <span
            className="text-[10px] font-bold bg-amber-600 text-white rounded-full px-1.5 py-0.5 min-w-[18px] text-center"
            title={`${bot.pending_count} pending approval${bot.pending_count === 1 ? "" : "s"}`}
          >
            {bot.pending_count}
          </span>
      ) : undefined}
      trailing={bot.cost_today_usd > 0 ? (
          <span className="text-xs text-zinc-400 tabular-nums" title="Cost today (UTC)">
            ${bot.cost_today_usd.toFixed(2)}
          </span>
      ) : undefined}
      className="gap-3 px-2.5 hover:bg-zinc-900"
    />
  );
}

export default function FleetPage() {
  const navigate = useNavigate();
  const requestActivityOpen = useActivityUiStore((s) => s.requestOpen);
  const {
    workspaces,
    personalWorkspace,
    selectedWorkspaceId,
    setWorkspaces,
    setPersonalWorkspace,
  } = useChatStore();

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
  const [catalog, setCatalog] = useState<BotItem[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);

  const refreshCatalog = useCallback(
    async (quiet = false) => {
      try {
        const [b, c] = await Promise.all([
          listBots(),
          listChannels(activeWsId ?? undefined).catch(() => [] as Channel[]),
        ]);
        setCatalog(b);
        setChannels(c);
        if (!quiet) setError(null);
      } catch (e) {
        if (!quiet) {
          toast.error(e instanceof Error ? e.message : "Couldn't load bot catalog");
        }
      }
    },
    [activeWsId]
  );

  const refresh = useCallback(
    async (workspaceId: string, quiet = false) => {
      if (!quiet) setRefreshing(true);
      try {
        const res = await getFleet(workspaceId);
        setApprovals(res.approvals);
        setBots(res.bots);
        setError(null);
        void refreshCatalog(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load the fleet");
      } finally {
        setLoading(false);
        if (!quiet) setRefreshing(false);
      }
    },
    [refreshCatalog]
  );

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

  const liveChannelIds = useMemo(
    () => [...new Set(bots.map((b) => b.channel_id))],
    [bots]
  );
  useFleetLive(liveChannelIds, () => {
    if (activeWsId) refresh(activeWsId, true);
  });

  const actionableCount = approvals.filter((a) => a.actionable).length;

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

  const selectedBot = useMemo(
    () => catalog.find((b) => b.bot_id === selectedBotId) ?? null,
    [catalog, selectedBotId]
  );

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

  async function onIssue(botId: string) {
    try {
      setIssued(await issueBotToken(botId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't issue token");
    }
  }

  async function openBot(botId: string) {
    try {
      const [b, c] = await Promise.all([
        listBots(),
        listChannels(activeWsId ?? undefined).catch(() => [] as Channel[]),
      ]);
      setCatalog(b);
      setChannels(c);
      if (!b.some((bot) => bot.bot_id === botId)) {
        toast.error("Couldn't open bot details — you may not manage this bot.");
        return;
      }
      setSelectedBotId(botId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open bot details");
    }
  }

  return (
    <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-zinc-800 flex-shrink-0">
        <UiButton variant="plain"
          onClick={() => navigate("/chat")}
          title="Back to chat"
          square controlSize="regular" className=" max-md: max-md:-ml-2 rounded-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex items-center justify-center transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </UiButton>
        <Radar className="w-4 h-4 text-indigo-400" />
        <h1 className="text-lg font-semibold">Fleet</h1>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            <Wand2 className="w-3.5 h-3.5" />
            Add bot
          </Button>
          {wsOptions.length > 1 && (
            <Select
              value={activeWsId ?? ""}
              onChange={(e) => setWsId(e.target.value)}
              aria-label="Workspace"
              controlSize="regular" className=" text-xs w-44"
            >
              {wsOptions.map((w) => (
                <option key={w.workspace_id} value={w.workspace_id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <UiButton variant="plain"
            onClick={() => activeWsId && refresh(activeWsId)}
            title="Refresh"
            aria-label="Refresh"
            disabled={refreshing || !activeWsId}
            square controlSize="regular" className=" max-md: rounded-sm text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 flex items-center justify-center transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          </UiButton>
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

              {actionableCount > 0 && (
                <UiButton variant="plain"
                  type="button"
                  onClick={() => {
                    // ActivityCenter lives in the chat shell rail — open the
                    // dialog via the shared store, then land on /chat so it mounts.
                    requestActivityOpen();
                    navigate("/chat");
                  }}
                  controlSize="regular" className="w-full flex items-center gap-3 rounded-sm bg-amber-950/30 px-4 text-left hover:bg-amber-950/50 transition-colors"
                >
                  <Inbox className="w-4 h-4 text-amber-300 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-100">
                      {actionableCount} waiting on you
                    </p>
                    <p className="text-xs text-zinc-400">Review in Activity</p>
                  </div>
                </UiButton>
              )}

              <section>
                <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Bots
                </h2>
                {botsByChannel.length === 0 ? (
                  <EmptyState
                    icon={BotIcon}
                    title="No bots in this workspace"
                    hint="Add a bot here, then connect it on the machine that will run it."
                  />
                ) : (
                  <div className="space-y-5">
                    {/* design-system-exempt: item-section — channel grouping delegates rows to BotRow. */}
                    {botsByChannel.map(([channelId, g]) => (
                      <div key={channelId}>
                        <p className="text-[10px] uppercase tracking-wide text-zinc-400 mb-1 px-2.5">
                          {channelLabel(g.name)}
                        </p>
                        <div>
                          {g.bots.map((b) => (
                            <BotRow
                              key={`${b.bot_id}:${b.channel_id}`}
                              bot={b}
                              onSelect={() => openBot(b.bot_id)}
                            />
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

      {selectedBot && (
        <Dialog
          title={selectedBot.display_name || selectedBot.username}
          onClose={() => setSelectedBotId(null)}
          maxWidth="max-w-3xl"
        >
          <BotDetailPanel
            key={selectedBot.bot_id}
            bot={selectedBot}
            channels={channels}
            onIssue={onIssue}
            onError={(m) => toast.error(m)}
            onChanged={() => {
              void refreshCatalog();
              if (activeWsId) void refresh(activeWsId, true);
            }}
            onPoll={() => void refreshCatalog(true)}
          />
        </Dialog>
      )}

      {issued && (
        <Dialog
          title={
            <span className="flex items-center gap-2">
              <KeyRound className="w-5 h-5 text-indigo-400" /> Connection token
            </span>
          }
          onClose={() => setIssued(null)}
          maxWidth="max-w-lg"
        >
          <p className="text-xs text-amber-400">
            {issued.note ?? "Store this token now — shown only once."}
          </p>
          <div className="rounded-sm bg-zinc-950 p-3">
            <code className="text-xs text-emerald-300 break-all">{issued.token}</code>
          </div>
          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-xs text-zinc-400">
              Save this into the bot&apos;s token file on the machine that runs it.
            </span>
            <CopyButton value={issued.token} label="Copy token" />
          </div>
        </Dialog>
      )}

      {wizardOpen && (
        <BotOnboardingWizard
          bots={catalog}
          onClose={() => setWizardOpen(false)}
          onDone={() => {
            void refreshCatalog();
            if (activeWsId) void refresh(activeWsId);
          }}
        />
      )}
    </div>
  );
}
