import { HelpLabel } from "@/components/ui/help-text";
import { SectionNav } from "@/components/ui/section-nav";
import { ButtonGroup } from "@/components/ui/button-group";
import { ContentActionScope } from "@/components/ui/content-action-scope";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  CircleGauge,
  History,
  Laptop,
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
import { BotIcon, FleetIcon } from "@/components/ui/editorial-icons";
import { NavigationItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { UnreadBadge } from "@/components/ui/unread-badge";
import {
  getAllFleet, getFleetAudit, getFleetHosts,
  type FleetApproval, type FleetAuditEvent, type FleetBot, type FleetHost,
} from "@/api/fleet";
import { listBots } from "@/api/bots";
import { useFleetLive } from "./useFleetLive";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import { CreateBotDialog } from "@/features/bots/CreateBotDialog";
import { CreateHostWizard } from "@/features/bots/CreateHostWizard";
import { BotDetailPanel } from "@/features/bots/BotDetailPanel";
import type { BotItem } from "@/types";
import { FleetAudit } from "./FleetAudit";
import { FleetBots } from "./FleetBots";
import { FleetHosts } from "./FleetHosts";
import { FleetOverview } from "./FleetOverview";

const POLL_MS = 30_000;
type Section = "overview" | "bots" | "hosts" | "audit";

const sections: Array<{ id: Section; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: "overview", label: "Overview", icon: CircleGauge },
  { id: "bots", label: "Bots", icon: BotIcon },
  { id: "hosts", label: "Hosts", icon: Laptop },
  { id: "audit", label: "Audit", icon: History },
];

function sectionFromPath(pathname: string): Section {
  const value = pathname.split("/")[2];
  return value === "bots" || value === "hosts" || value === "audit" ? value : "overview";
}
function botRoute(pathname: string): { botId?: string; tab?: string } {
  const [, , section, botId, tab] = pathname.split("/");
  return section === "bots" && botId ? { botId, tab } : {};
}

function AddMenu({
  onNewBot,
  onHost,
  onRedeem,
}: {
  onNewBot: () => void;
  onHost: () => void;
  onRedeem?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);
  return <div className="relative" ref={rootRef}>
    <ActionButton action="add" context="toolbar" accessibleLabel="Create bot or host" controlSize="regular" onClick={() => setOpen((value) => !value)} />
    {open && <PopoverPanel placement="down" align="end" className="w-56 p-1">
      <NavigationItem title="New bot" leading={<BotIcon className="h-4 w-4" />} onClick={() => { setOpen(false); onNewBot(); }} />
      <NavigationItem title="Add host" leading={<Laptop className="h-4 w-4" />} onClick={() => { setOpen(false); onHost(); }} />
      {isTauri() && <NavigationItem title="Use pairing code" leading={<ShieldAlert className="h-4 w-4" />} onClick={() => { setOpen(false); onRedeem?.(); }} />}
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
  const [hosts, setHosts] = useState<FleetHost[]>([]);
  const [audit, setAudit] = useState<FleetAuditEvent[]>([]);
  const [catalog, setCatalog] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [hostBotId, setHostBotId] = useState<string | undefined>();

  const applyFleet = useCallback((fleet: Awaited<ReturnType<typeof getAllFleet>>) => {
    setApprovals(fleet.approvals);
    setBots(fleet.bots);
    setSummary(fleet.summary ?? {
      online: fleet.bots.filter((bot) => bot.online && bot.busy_sessions === 0).length,
      working: fleet.bots.filter((bot) => bot.online && bot.busy_sessions > 0).length,
      offline: fleet.bots.filter((bot) => !bot.online).length,
      waiting: fleet.approvals.filter((approval) => approval.actionable).length,
    });
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    // Roster and catalog gate the first paint; hosts and the audit feed fill in
    // when they land instead of holding the whole page on the slowest request.
    const extras = Promise.all([
      getFleetHosts().catch(() => []).then(setHosts),
      getFleetAudit({ limit: 100 }).catch(() => ({ events: [] })).then((result) => setAudit(result.events)),
    ]);
    try {
      const [fleet, botCatalog] = await Promise.all([getAllFleet(), listBots()]);
      applyFleet(fleet);
      setCatalog(botCatalog);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Couldn't load Fleet"); }
    finally { setLoading(false); }
    await extras;
    if (!quiet) setRefreshing(false);
  }, [applyFleet]);

  // Channel activity only moves approvals, liveness and sessions; the catalog,
  // hosts and audit feed follow the slower poll.
  const refreshLive = useCallback(async () => {
    try { applyFleet(await getAllFleet()); } catch { /* the next poll retries */ }
  }, [applyFleet]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const liveChannelIds = useMemo(() => [...new Set(bots.flatMap((bot) => bot.channels?.map((item) => item.channel_id) ?? (bot.channel_id ? [bot.channel_id] : [])))], [bots]);
  useFleetLive(liveChannelIds, () => void refreshLive());
  const selectedBot = catalog.find((bot) => bot.bot_id === route.botId);
  const actionableCount = approvals.filter((approval) => approval.actionable).length;
  const hostIssues = hosts.filter((item) => !item.revoked_at && (item.mcp_connection_state === "action_required" || item.mcp_connection_state === "refresh_failed")).length;
  const manageableBots = catalog.filter((bot) => bot.can_manage);

  function openBot(botId: string, tab = "overview") { navigate(`/fleet/bots/${botId}/${tab}`); }
  function openHost(botId?: string) { setHostBotId(botId ?? ""); }

  const headerActions = (
    <>
      <AddMenu
        onNewBot={() => setCreateBotOpen(true)}
        onHost={() => openHost()}
        onRedeem={() => navigate("/fleet/hosts?redeem=1")}
      />
      <IconButton label="Refresh Fleet" disabled={refreshing} onClick={() => void refresh()}>
        <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden="true" />
      </IconButton>
    </>
  );

  return <div className="h-full overflow-y-auto overscroll-contain bg-canvas text-content-primary">
    <RouteChromeHeader>
      <header className="mx-auto flex w-full max-w-5xl items-center gap-4 px-6 py-5 max-md:px-4">
        <UiButton
          variant="plain"
          type="button"
          content="icon"
          controlSize="regular"
          onClick={() => navigate("/chat")}
          title="Back to chat"
          aria-label="Back to chat"
          className="rounded-sm text-content-primary transition-colors hover:text-content-strong"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </UiButton>
        <FleetIcon className="text-accent-400" />
        <div>
          <h1 className="font-serif text-regular font-bold tracking-tight text-content-strong leading-none"><HelpLabel help={<>Personal bot cockpit</>}>Fleet</HelpLabel></h1>

        </div>
      </header>
    </RouteChromeHeader>
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6 max-md:p-4 max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))] sm:flex-row">
      <SectionNav
        ariaLabel="Fleet sections"
        items={sections.map((item) => ({
          ...item,
          badge: item.id === "overview" && actionableCount > 0 ? (
            <UnreadBadge tone="approval" contentSize="small">{actionableCount}</UnreadBadge>
          ) : undefined,
        }))}
        selected={section}
        onSelect={(id) => navigate(id === "overview" ? "/fleet" : `/fleet/${id}`)}
      />
      <main className="min-w-0 flex-1">
        <ContentActionScope>
        <div className="mb-4 flex flex-wrap items-center gap-3" data-content-toolbar="fleet">
          <h2 className="text-comfortable font-semibold">{sections.find(item => item.id === section)?.label ?? "Fleet"}</h2>
          <ButtonGroup label="Fleet actions" controlSize="regular">{headerActions}</ButtonGroup>
        </div>
        <div className="space-y-7">
        {loading ? <SurfaceSpinner /> : section === "overview" ? (
          <FleetOverview
            summary={summary}
            actionableCount={actionableCount}
            hostIssues={hostIssues}
            bots={bots}
            audit={audit}
            onOpenBot={openBot}
            onOpenAllBots={() => navigate("/fleet/bots")}
            onOpenActivity={() => navigate("/activity")}
            onOpenHosts={() => navigate("/fleet/hosts")}
          />
        ) : section === "bots" ? (
          <FleetBots bots={bots} onOpenBot={openBot} />
        ) : section === "hosts" ? (
          <FleetHosts items={hosts} refresh={async () => { await refresh(true); }} />
        ) : (
          <FleetAudit events={audit} bots={bots} />
        )}
        </div>
        </ContentActionScope>
      </main>
    </div>
    {selectedBot && <Dialog ariaLabel={`${selectedBot.display_name || selectedBot.username} — Bot details`} onClose={() => navigate("/fleet/bots")} maxWidth="max-w-3xl"><BotDetailPanel onClose={() => navigate("/fleet/bots")} key={selectedBot.bot_id} bot={selectedBot} initialTab={route.tab} onError={(message) => toast.error(message)} onChanged={() => void refresh(true)} onPoll={() => void refresh(true)} onAddHost={() => { navigate("/fleet/hosts"); openHost(selectedBot.bot_id); }} /></Dialog>}
    {createBotOpen && <CreateBotDialog onClose={() => setCreateBotOpen(false)} onCreated={(bot) => {
      setCreateBotOpen(false);
      // Seed from the POST response (it carries can_manage) rather than waiting
      // on the Fleet refetch: the wizard resolves its bot out of manageableBots.
      setCatalog((prev) => (prev.some((b) => b.bot_id === bot.bot_id) ? prev : [bot, ...prev]));
      // A bot identity can't do anything until a device runs it — continue there
      // instead of ending the flow on a row that has no runtime behind it.
      openHost(bot.bot_id);
      void refresh(true);
    }} />}
    {hostBotId !== undefined && <CreateHostWizard bots={manageableBots} initialBotId={hostBotId || undefined} onClose={() => setHostBotId(undefined)} onDone={() => void refresh()} />}
  </div>;
}
