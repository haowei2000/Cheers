import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Bot as BotIcon, CircleGauge, History, Inbox, Laptop,
  MoreHorizontal, Play, Radar, RefreshCw, RotateCw, ShieldAlert, Trash2,
} from "lucide-react";
import toast from "react-hot-toast";
import { cn } from "@/lib/cn";
import { isTauri } from "@/lib/serverConfig";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import { SurfaceSpinner } from "@/components/ui/spinner";
import { ActionButton } from "@/components/ui/action-button";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EntityItem, ItemList, ItemSection, NavigationItem, OperationsItem } from "@/components/ui/item";
import { IconButton } from "@/components/ui/icon-button";
import { OverflowText } from "@/components/ui/overflow-text";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { UnreadBadge } from "@/components/ui/unread-badge";
import {
  getAllFleet, getFleetAudit, getFleetInstallations,
  type FleetApproval, type FleetAuditEvent, type FleetBot, type FleetInstallation,
} from "@/api/fleet";
import {
  activateTerminalInstallation, listBots, reconnectTerminalInstallation,
  revokeTerminalInstallation, rotateTerminalCredential,
} from "@/api/bots";
import { listChannels } from "@/api/channels";
import { useFleetLive } from "./useFleetLive";
import { RouteChromeHeader } from "@/features/desktop/RouteChromeHeader";
import { BotOnboardingWizard } from "@/features/bots/BotOnboardingWizard";
import { BotDetailPanel, CopyButton } from "@/features/bots/BotDetailPanel";
import { ConnectorManager } from "@/features/desktop/ConnectorManager";
import type { BotItem, Channel } from "@/types";

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

function statusText(bot: FleetBot) {
  if (bot.is_disabled) return "Disabled";
  if (!bot.online) return "Offline";
  if (bot.pending_count > 0) return "Waiting approval";
  if (bot.busy_sessions > 0) return "Working";
  return "Idle";
}

function BotRow({ bot, onSelect }: { bot: FleetBot; onSelect: () => void }) {
  const sessions = bot.busy_sessions + bot.idle_sessions;
  const channels = bot.channels?.map((item) => item.channel_name || "Direct message").join(", ");
  return <EntityItem
    onClick={onSelect}
    title={<OverflowText fullText={bot.bot_name} touchDisclosure={false}>{bot.bot_name}</OverflowText>}
    leading={<Avatar name={bot.bot_name} id={bot.bot_id} size="regular" online={bot.online} />}
    subtitle={[
      bot.status_emoji && bot.status_text ? `${bot.status_emoji} ${bot.status_text}` : bot.status_text,
      sessions ? `${sessions} session${sessions === 1 ? "" : "s"}` : null,
      channels,
    ].filter(Boolean).join(" · ") || undefined}
    criticalStatus={bot.pending_count > 0 ? <UnreadBadge tone="approval" contentSize="regular">{bot.pending_count}</UnreadBadge> : undefined}
    status={<span className="text-compact text-zinc-400">{statusText(bot)}</span>}
    trailing={<span className="flex items-center gap-2 text-compact text-zinc-400">
      <span>{bot.can_manage ? "Mine" : "Shared"}</span>
      {bot.installation_count ? <span>{bot.installation_count} install.</span> : null}
      {bot.cost_today_usd > 0 ? <span className="tabular-nums">${bot.cost_today_usd.toFixed(2)}</span> : null}
    </span>}
  />;
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

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className="rounded-sm bg-zinc-900/60 px-4 py-3">
    <p className="text-minimal uppercase tracking-[0.1em] text-zinc-400">{label}</p>
    <p className={cn("mt-1 text-comfortable font-semibold tabular-nums text-zinc-100", tone)}>{value}</p>
  </div>;
}

function InstallationsView({ items, refresh }: { items: FleetInstallation[]; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ device: string; credential: string } | null>(null);
  async function act(item: FleetInstallation, operation: () => Promise<unknown>, message: string) {
    setBusy(item.installation_id);
    try { await operation(); toast.success(message); await refresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Operation failed"); }
    finally { setBusy(null); }
  }
  async function rotate(item: FleetInstallation) {
    setBusy(item.installation_id);
    try {
      const result = await rotateTerminalCredential(item.bot_id, item.installation_id);
      setIssued({ device: item.device_name, credential: result.credential });
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't rotate credential");
    } finally {
      setBusy(null);
    }
  }
  return <div className="space-y-7">
    <ItemSection label="Registered installations" description="Device registrations and credentials managed by the Cheers server." presentationLevel="max" controlSize="regular">
      {items.length === 0 ? <EmptyState icon={Laptop} title="No installations yet" hint="Use Add installation to choose a bot and connect a device." /> : items.map((item) => <OperationsItem
        key={item.installation_id}
        title={`${item.bot_name} · ${item.device_name}`}
        subtitle={`${item.agent_type} · ${item.credential_prefix}`}
        metadata={`Last seen ${item.last_seen_at ? new Date(item.last_seen_at).toLocaleString() : "never"} · MCP ${item.mcp_connection_state.replaceAll("_", " ")}`}
        leading={<Laptop className="h-4 w-4 text-zinc-400" />}
        status={<span className={cn("text-compact", item.online ? "text-emerald-400" : "text-zinc-400")}>{item.revoked_at ? "Revoked" : item.online ? "Online" : item.status}</span>}
        actions={item.revoked_at ? undefined : <>
          {item.status === "standby" && <IconButton label="Activate installation" disabled={busy === item.installation_id} onClick={() => void act(item, () => activateTerminalInstallation(item.bot_id, item.installation_id), "Installation activated")}><Play className="h-4 w-4" /></IconButton>}
          {item.status !== "pending" && <IconButton label="Rotate credential" disabled={busy === item.installation_id} onClick={() => void rotate(item)}><RotateCw className="h-4 w-4" /></IconButton>}
          {item.status === "active" && <IconButton label="Reconnect installation" disabled={busy === item.installation_id} onClick={() => void act(item, () => reconnectTerminalInstallation(item.bot_id, item.installation_id), "Reconnect requested")}><RefreshCw className="h-4 w-4" /></IconButton>}
          <IconButton label="Revoke installation" tone="danger" disabled={busy === item.installation_id} onClick={() => { if (window.confirm(`Revoke installation “${item.device_name}”?`)) void act(item, () => revokeTerminalInstallation(item.bot_id, item.installation_id), "Installation revoked"); }}><Trash2 className="h-4 w-4" /></IconButton>
        </>}
      />)}
    </ItemSection>
    {isTauri() && <section className="space-y-3"><div><h2 className="font-utility text-compact font-semibold uppercase tracking-[0.1em] text-zinc-400">This Mac</h2><p className="mt-1 text-compact text-zinc-400">Local connector processes, logs, workspaces, and runtime health.</p></div><ConnectorManager /></section>}
    {issued && <Dialog title={`Credential for ${issued.device}`} onClose={() => setIssued(null)} maxWidth="max-w-lg">
      <div className="space-y-3"><p className="text-compact text-amber-200">This credential is shown once. Replace the installation credential before reconnecting.</p><code className="block break-all rounded-sm bg-zinc-950 p-3 text-compact text-zinc-200 select-all">{issued.credential}</code><CopyButton value={issued.credential} /></div>
    </Dialog>}
  </div>;
}

function AuditView({ events, bots }: { events: FleetAuditEvent[]; bots: FleetBot[] }) {
  const names = new Map(bots.map((bot) => [bot.bot_id, bot.bot_name]));
  return <ItemSection label="Audit timeline" description="Management, connection, ACP, and approval events for bots you manage." presentationLevel="max" controlSize="regular">
    {events.length === 0 ? <EmptyState icon={History} title="No audit events" hint="Bot and installation changes will appear here." /> : events.map((event) => <OperationsItem
      key={`${event.source}:${event.id}`}
      title={event.event_type.replaceAll(".", " · ").replaceAll("_", " ")}
      subtitle={[event.bot_id ? names.get(event.bot_id) ?? event.bot_id : null, new Date(event.created_at).toLocaleString()].filter(Boolean).join(" · ")}
      leading={<History className="h-4 w-4 text-zinc-400" />}
      status={<span className="text-compact capitalize text-zinc-400">{event.source}</span>}
    />)}
  </ItemSection>;
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardBotId, setWizardBotId] = useState<string | undefined>();

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
  function openWizard(botId?: string) { setWizardBotId(botId); setWizardOpen(true); }

  const headerActions = <><AddMenu onNewBot={() => openWizard()} onInstallation={() => openWizard(manageableBots[0]?.bot_id)} /><IconButton label="Refresh Fleet" disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} aria-hidden="true" /></IconButton></>;

  return <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
    <RouteChromeHeader actions={headerActions}>
      <header className="flex h-11 flex-shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <IconButton label="Back to chat" onClick={() => navigate("/chat")}><ArrowLeft className="h-4 w-4" aria-hidden="true" /></IconButton>
        <Radar className="h-4 w-4 text-indigo-400" aria-hidden="true" /><div><h1 className="text-comfortable font-semibold leading-none">Fleet</h1><p className="mt-1 hidden text-minimal text-zinc-400 sm:block">Personal bot cockpit</p></div>
        <div className="ml-auto flex items-center gap-1">{headerActions}</div>
      </header>
    </RouteChromeHeader>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Fleet sections" className="flex flex-shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 p-2 md:w-48 md:flex-col md:border-b-0 md:border-r">
        {sections.map((item) => { const Icon = item.icon; return <NavigationItem key={item.id} title={item.label} leading={<Icon className="h-4 w-4" />} selected={section === item.id} onClick={() => navigate(item.id === "overview" ? "/fleet" : `/fleet/${item.id}`)} criticalStatus={item.id === "overview" && actionableCount > 0 ? <UnreadBadge tone="approval" contentSize="small">{actionableCount}</UnreadBadge> : undefined} />; })}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-4xl space-y-7 px-4 py-6">
        {loading ? <SurfaceSpinner /> : section === "overview" ? <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5"><SummaryCard label="Online" value={summary.online} /><SummaryCard label="Working" value={summary.working} tone="text-indigo-200" /><SummaryCard label="Offline" value={summary.offline} /><SummaryCard label="Waiting" value={summary.waiting} tone={summary.waiting ? "text-amber-300" : undefined} /><SummaryCard label="Install issues" value={installationIssues} tone={installationIssues ? "text-amber-300" : undefined} /></div>
          {(actionableCount > 0 || installationIssues > 0) && <ItemSection label="Needs attention" presentationLevel="medium" controlSize="regular">
            {actionableCount > 0 && <OperationsItem title={`${actionableCount} waiting on you`} subtitle="Review approvals in your personal Activity inbox" leading={<Inbox className="h-4 w-4 text-amber-300" />} criticalStatus={<UnreadBadge tone="approval" contentSize="regular">{actionableCount}</UnreadBadge>} onClick={() => navigate("/activity")} />}
            {installationIssues > 0 && <OperationsItem title={`${installationIssues} installation issue${installationIssues === 1 ? "" : "s"}`} subtitle="MCP authorization or refresh needs attention" leading={<ShieldAlert className="h-4 w-4 text-amber-300" />} onClick={() => navigate("/fleet/installations")} />}
          </ItemSection>}
          <ItemSection label="Recent bots" action={<Button action="open" variant="ghost" controlSize="compact" onClick={() => navigate("/fleet/bots")}>View all</Button>} presentationLevel="medium" controlSize="regular">{bots.slice(0, 6).map((bot) => <BotRow key={bot.bot_id} bot={bot} onSelect={() => openBot(bot.bot_id)} />)}</ItemSection>
          <AuditView events={audit.slice(0, 8)} bots={bots} />
        </> : section === "bots" ? <ItemSection label={`Bots ${bots.length}`} description="All bots you own or share a channel with. Workspace and channel are context, not navigation." presentationLevel="max" controlSize="regular">
          {bots.length ? bots.map((bot) => <BotRow key={bot.bot_id} bot={bot} onSelect={() => openBot(bot.bot_id)} />) : <EmptyState icon={BotIcon} title="No bots yet" hint="Create a bot, then connect it on the device that will run it." />}
        </ItemSection> : section === "installations" ? <InstallationsView items={installations} refresh={async () => { await refresh(true); }} /> : <AuditView events={audit} bots={bots} />}
      </div></main>
    </div>
    {selectedBot && <Dialog title={selectedBot.display_name || selectedBot.username} onClose={() => navigate("/fleet/bots")} maxWidth="max-w-3xl"><BotDetailPanel key={selectedBot.bot_id} bot={selectedBot} channels={channels} initialTab={route.tab} onError={(message) => toast.error(message)} onChanged={() => void refresh(true)} onPoll={() => void refresh(true)} onAddInstallation={() => { navigate("/fleet/installations"); openWizard(selectedBot.bot_id); }} /></Dialog>}
    {wizardOpen && <BotOnboardingWizard bots={manageableBots} initialBotId={wizardBotId} onClose={() => { setWizardOpen(false); setWizardBotId(undefined); }} onDone={() => void refresh()} />}
  </div>;
}
