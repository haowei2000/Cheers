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
  Copy,
  Check,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityItem, ItemList, ItemSection, OperationsItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { OverflowText } from "@/components/ui/overflow-text";
import { UnreadBadge } from "@/components/ui/unread-badge";
import { getFleet, type FleetApproval, type FleetBot } from "@/api/fleet";
import { listWorkspaces, getPersonalWorkspace } from "@/api/workspaces";
import { listBots, issueBotToken, type IssuedToken } from "@/api/bots";
import { listChannels } from "@/api/channels";
import { useFleetLive } from "./useFleetLive";
import { useChatStore } from "@/stores/chatStore";
import { useActivityUiStore } from "@/stores/activityUiStore";
import { BotOnboardingWizard } from "@/features/bots/BotOnboardingWizard";
import { BotDetailPanel } from "@/features/bots/BotDetailPanel";
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
    return <span className="text-zinc-400">Offline</span>;
  }
  if (bot.pending_count > 0) {
    return <span className="text-amber-300">Waiting approval</span>;
  }
  if (bot.busy_sessions > 0) {
    return <span className="text-indigo-200">Working</span>;
  }
  return <span className="text-zinc-400">Idle</span>;
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
    <EntityItem
      onClick={onSelect}
      title={<OverflowText fullText={bot.bot_name} touchDisclosure={false}>{bot.bot_name}</OverflowText>}
      subtitle={[
        bot.status_emoji && bot.status_text ? `${bot.status_emoji} ${bot.status_text}` : bot.status_text,
        sessions,
      ].filter(Boolean).join(" · ") || undefined}
      leading={<Avatar name={bot.bot_name} id={bot.bot_id} size="regular" online={bot.online} />}
      status={<StatusChip bot={bot} />}
      criticalStatus={bot.pending_count > 0 ? (
          <UnreadBadge
            tone="approval"
            contentSize="regular"
            title={`${bot.pending_count} pending approval${bot.pending_count === 1 ? "" : "s"}`}
            aria-label={`${bot.pending_count} pending approval${bot.pending_count === 1 ? "" : "s"}`}
          >
            {bot.pending_count}
          </UnreadBadge>
      ) : undefined}
      trailing={bot.cost_today_usd > 0 ? (
          <span
            className="text-compact text-zinc-400 tabular-nums"
            title="Cost today (UTC)"
          >
            ${bot.cost_today_usd.toFixed(2)}
          </span>
      ) : undefined}
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
  const [tokenCopied, setTokenCopied] = useState(false);

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
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <IconButton
          label="Back to chat"
          onClick={() => navigate("/chat")}
          controlSize="regular"
          className="max-md:-ml-2"
        >
          <ArrowLeft className="w-4 h-4" />
        </IconButton>
        <Radar className="w-4 h-4 text-indigo-400" />
        <h1 className="text-comfortable font-semibold">Fleet</h1>
        <div className="ml-auto flex min-w-0 items-center gap-1">
          <Button
            content="iconText"
            action="add"
            aria-label="Add bot"
            variant="secondary"
            controlSize="regular"
            onClick={() => setWizardOpen(true)}
          >
            <Wand2 className="w-3.5 h-3.5" />
          </Button>
          {wsOptions.length > 1 && (
            <Select
              value={activeWsId ?? ""}
              onChange={(e) => setWsId(e.target.value)}
              aria-label="Workspace"
              controlSize="regular"
              controlWidth="slot"
            >
              {wsOptions.map((w) => (
                <option key={w.workspace_id} value={w.workspace_id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
          <IconButton
            label="Refresh fleet"
            onClick={() => activeWsId && refresh(activeWsId)}
            disabled={refreshing || !activeWsId}
            controlSize="regular"
          >
            <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
          </IconButton>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 py-6 space-y-8">
          {loading ? (
            <SurfaceSpinner />
          ) : (
            <>
              {error && (
                <ItemList presentationLevel="medium" controlSize="regular">
                  <OperationsItem
                    title="Fleet unavailable"
                    criticalStatus={<span className="text-red-400">Error</span>}
                    subtitle={error}
                    actions={activeWsId ? (
                      <IconButton label="Retry loading fleet" controlSize="regular" onClick={() => void refresh(activeWsId)}>
                        <RefreshCw className="h-4 w-4" />
                      </IconButton>
                    ) : undefined}
                  />
                </ItemList>
              )}

              {actionableCount > 0 && (
                <ItemList presentationLevel="medium" controlSize="regular">
                  <OperationsItem
                    title={`${actionableCount} waiting on you`}
                    subtitle="Review in Activity"
                    leading={<Inbox className="h-4 w-4 text-amber-300" />}
                    criticalStatus={<UnreadBadge tone="approval" contentSize="regular">{actionableCount}</UnreadBadge>}
                    onClick={() => {
                    // ActivityCenter lives in the chat shell rail — open the
                    // dialog via the shared store, then land on /chat so it mounts.
                    requestActivityOpen();
                    navigate("/chat");
                  }}
                  />
                </ItemList>
              )}

              {botsByChannel.length === 0 ? (
                <EmptyState
                  icon={BotIcon}
                  title="No bots in this workspace"
                  hint="Add a bot here, then connect it on the machine that will run it."
                />
              ) : (
                <div className="space-y-5">
                  <h2 className="px-1 font-utility text-compact font-semibold uppercase tracking-[0.1em] text-zinc-400">
                    Bots <span className="font-normal text-zinc-400">{bots.length}</span>
                  </h2>
                    {botsByChannel.map(([channelId, g]) => (
                      <ItemSection
                        key={channelId}
                        label={channelLabel(g.name)}
                        presentationLevel="medium"
                        controlSize="regular"
                      >
                        {g.bots.map((b) => (
                          <BotRow
                            key={`${b.bot_id}:${b.channel_id}`}
                            bot={b}
                            onSelect={() => openBot(b.bot_id)}
                          />
                        ))}
                      </ItemSection>
                    ))}
                </div>
              )}
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
          <p className="text-compact text-amber-400">
            {issued.note ?? "Store this token now — shown only once."}
          </p>
          <div className="rounded-sm bg-zinc-950 p-3">
            <code className="text-compact text-emerald-300 break-all">{issued.token}</code>
          </div>
          <div className="flex items-center justify-between gap-3 mt-3">
            <span className="text-compact text-zinc-400">
              Save this into the bot&apos;s token file on the machine that runs it.
            </span>
            <IconButton
              label="Copy connection token"
              controlSize="regular"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued.token);
                  setTokenCopied(true);
                  window.setTimeout(() => setTokenCopied(false), 1500);
                } catch {
                  toast.error("Clipboard unavailable — select and copy manually");
                }
              }}
            >
              {tokenCopied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            </IconButton>
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
