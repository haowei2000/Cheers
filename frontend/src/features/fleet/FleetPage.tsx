import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Bot as BotIcon,
  CircleGauge,
  History,
  Laptop,
  Radar,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/serverConfig";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { ActionButton } from "@/components/ui/action-button";
import { Button as UiButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { NavigationItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { UnreadBadge } from "@/components/ui/unread-badge";
import {
  getAllFleet, getFleetAudit, getFleetInstallations,
  type FleetApproval, type FleetAuditEvent, type FleetBot, type FleetInstallation,
} from "@/api/fleet";
import { listBots } from "@/api/bots";
import { listChannels } from "@/api/channels";
import { useFleetLive } from "./useFleetLive";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import { CreateBotDialog } from "@/features/bots/CreateBotDialog";
import { CreateInstallationWizard } from "@/features/bots/CreateInstallationWizard";
import { BotDetailPanel } from "@/features/bots/BotDetailPanel";
import type { BotItem, Channel } from "@/types";
import { FleetAudit } from "./FleetAudit";
import { FleetBots } from "./FleetBots";
import { FleetInstallations } from "./FleetInstallations";
import { FleetOverview } from "./FleetOverview";

const POLL_MS = 30_000;
type Section = "overview" | "bots" | "installations" | "audit";

const sections: Array<{ id: Section; label: string; icon: typeof Radar }> = [
  { id: "overview", label: "Overview", icon: CircleGauge },
  { id: "bots", label: "Bots", icon: BotIcon },
  { id: "installations", label: "Installations", icon: Laptop },
  { id: "audit", label: "Audit", icon: History },
];

function sectionFromPath(pathname: string): Section {
  const value = pathname.split("/")[2];
  return value === "bots" || value === "installations" || value === "audit" ? value : "overview";
}

function botRoute(pathname: string): { botId?: string; tab?: string } {
  const [, , section, botId, tab] = pathname.split("/");
  return section === "bots" && botId ? { botId, tab } : {};
}

function AddMenu({ onNewBot, onInstallation }: { onNewBot: () => void; onInstallation: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);
  return <div className="relative" ref={rootRef}>
    <ActionButton action="add" context="toolbar" accessibleLabel="Create bot or installation" controlSize="regular" onClick={() => setOpen((value) => !value)} />
    {open && <PopoverPanel placement="down" align="end" className="w-56 p-1">
      <NavigationItem title="New bot" leading={<BotIcon className="h-4 w-4" />} onClick={() => { setOpen(false); onNewBot(); }} />
      <NavigationItem title="Add installation" leading={<Laptop className="h-4 w-4" />} onClick={() => { setOpen(false); onInstallation(); }} />
      {isTauri() && <NavigationItem title="Use pairing code" leading={<ShieldAlert className="h-4 w-4" />} onClick={() => { setOpen(false); location.assign("/fleet/installations?redeem=1"); }} />}
    </PopoverPanel>}
  </div>;
}

export default function FleetPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const section = sectionFromPath(location.pathname);
  const route = botRoute(location.pathname);
  const [approvals, setApprovals] = useState<FleetApproval[]>([]);
  const [bots, setBots] = useState<FleetBot[]>([]);
  const [summary, setSummary] = useState({ online: 0, working: 0, offline: 0, waiting: 0 });
  const [installations, setInstallations] = useState<FleetInstallation[]>([]);
  const [audit, setAudit] = useState<FleetAuditEvent[]>([]);
  const [catalog, setCatalog] = useState<BotItem[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [installationBotId, setInstallationBotId] = useState<string | undefined>();

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [fleet, botCatalog, channelCatalog, installationItems, auditResult] = await Promise.all([
        getAllFleet(), listBots(), listChannels().catch(() => [] as Channel[]),
        getFleetInstallations().catch(() => []), getFleetAudit({ limit: 100 }).catch(() => ({ events: [] })),
      ]);
      setApprovals(fleet.approvals);
      setBots(fleet.bots);
      setSummary(fleet.summary ?? {
        online: fleet.bots.filter((bot) => bot.online && bot.busy_sessions === 0).length,
        working: fleet.bots.filter((bot) => bot.online && bot.busy_sessions > 0).length,
        offline: fleet.bots.filter((bot) => !bot.online).length,
        waiting: fleet.approvals.filter((approval) => approval.actionable).length,
      });
      setCatalog(botCatalog); setChannels(channelCatalog); setInstallations(installationItems); setAudit(auditResult.events);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't load Fleet"); }
    finally { setLoading(false); if (!quiet) setRefreshing(false); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const liveChannelIds = useMemo(() => [...new Set(bots.flatMap((bot) => bot.channels?.map((item) => item.channel_id) ?? (bot.channel_id ? [bot.channel_id] : [])))], [bots]);
  useFleetLive(liveChannelIds, () => void refresh(true));
  const selectedBot = catalog.find((bot) => bot.bot_id === route.botId);
  const actionableCount = approvals.filter((approval) => approval.actionable).length;
  const installationIssues = installations.filter((item) => !item.revoked_at && (item.mcp_connection_state === "action_required" || item.mcp_connection_state === "refresh_failed")).length;
  const manageableBots = catalog.filter((bot) => bot.can_manage);

  function openBot(botId: string, tab = "overview") { navigate(`/fleet/bots/${botId}/${tab}`); }
  function openInstallation(botId?: string) { setInstallationBotId(botId ?? ""); }

  const headerActions = <><AddMenu onNewBot={() => setCreateBotOpen(true)} onInstallation={() => openInstallation()} /><IconButton label="Refresh Fleet" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden="true" /></IconButton></>;

  return <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
    <RouteChromeHeader actions={headerActions}>
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <IconButton label="Back to chat" onClick={() => navigate("/chat")}><ArrowLeft className="h-4 w-4" aria-hidden="true" /></IconButton>
        <Radar className="h-4 w-4 text-indigo-400" aria-hidden="true" /><div><h1 className="text-comfortable font-semibold leading-none">Fleet</h1><p className="mt-1 hidden text-minimal text-zinc-400 sm:block">Personal bot cockpit</p></div>
        <div className="ml-auto flex items-center gap-1">{headerActions}</div>
      </header>
    </RouteChromeHeader>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Fleet sections" className="flex flex-shrink-0 gap-1 overflow-x-auto p-2 md:w-48 md:flex-col">
        {sections.map((item) => {
          const Icon = item.icon;
          const active = section === item.id;
          return (
            <UiButton
              key={item.id}
              type="button"
              content="iconText"
              variant="plain"
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              controlSize="regular"
              onClick={() => navigate(item.id === "overview" ? "/fleet" : `/fleet/${item.id}`)}
              className={cn(
                "flex shrink-0 items-center gap-3 rounded-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-100 hover:bg-zinc-800 hover:text-zinc-50",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === "overview" && actionableCount > 0 ? (
                <UnreadBadge tone="approval" contentSize="small">
                  {actionableCount}
                </UnreadBadge>
              ) : null}
            </UiButton>
          );
        })}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-4xl space-y-7 px-4 py-6">
        {loading ? <SurfaceSpinner /> : section === "overview" ? (
          <FleetOverview
            summary={summary}
            actionableCount={actionableCount}
            installationIssues={installationIssues}
            bots={bots}
            audit={audit}
            onOpenBot={openBot}
            onOpenAllBots={() => navigate("/fleet/bots")}
            onOpenActivity={() => navigate("/activity")}
            onOpenInstallations={() => navigate("/fleet/installations")}
          />
        ) : section === "bots" ? (
          <FleetBots bots={bots} onOpenBot={openBot} />
        ) : section === "installations" ? (
          <FleetInstallations items={installations} refresh={async () => { await refresh(true); }} />
        ) : (
          <FleetAudit events={audit} bots={bots} />
        )}
      </div></main>
    </div>
    {selectedBot && <Dialog title={selectedBot.display_name || selectedBot.username} onClose={() => navigate("/fleet/bots")} maxWidth="max-w-3xl"><BotDetailPanel key={selectedBot.bot_id} bot={selectedBot} channels={channels} initialTab={route.tab} onError={(message) => toast.error(message)} onChanged={() => void refresh(true)} onPoll={() => void refresh(true)} onAddInstallation={() => { navigate("/fleet/installations"); openInstallation(selectedBot.bot_id); }} /></Dialog>}
    {createBotOpen && <CreateBotDialog onClose={() => setCreateBotOpen(false)} onCreated={(bot) => { setCreateBotOpen(false); void refresh(true); openBot(bot.bot_id); }} />}
    {installationBotId !== undefined && <CreateInstallationWizard bots={manageableBots} initialBotId={installationBotId || undefined} onClose={() => setInstallationBotId(undefined)} onDone={() => void refresh()} />}
  </div>;
}
