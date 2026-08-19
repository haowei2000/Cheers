import { Inbox, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ItemSection, OperationsItem } from "@/components/ui/item";
import { MetricCard } from "@/components/ui/metric-card";
import { UnreadBadge } from "@/components/ui/unread-badge";
import type { FleetAuditEvent, FleetBot } from "@/api/fleet";
import { FleetAudit } from "./FleetAudit";
import { BotRow } from "./FleetBots";

type FleetSummary = {
  online: number;
  working: number;
  offline: number;
  waiting: number;
};

export function FleetOverview({
  summary,
  actionableCount,
  hostIssues,
  bots,
  audit,
  onOpenBot,
  onOpenAllBots,
  onOpenActivity,
  onOpenHosts,
}: {
  summary: FleetSummary;
  actionableCount: number;
  hostIssues: number;
  bots: FleetBot[];
  audit: FleetAuditEvent[];
  onOpenBot: (botId: string) => void;
  onOpenAllBots: () => void;
  onOpenActivity: () => void;
  onOpenHosts: () => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <MetricCard label="Online" value={summary.online} />
        <MetricCard label="Working" value={summary.working} tone="accent" />
        <MetricCard label="Offline" value={summary.offline} />
        <MetricCard label="Waiting" value={summary.waiting} tone={summary.waiting ? "warning" : "neutral"} />
        <MetricCard
          label="Install issues"
          value={hostIssues}
          tone={hostIssues ? "warning" : "neutral"}
        />
      </div>
      {(actionableCount > 0 || hostIssues > 0) && (
        <ItemSection label="Needs attention" presentationLevel="medium" controlSize="regular">
          {actionableCount > 0 && (
            <OperationsItem
              title={`${actionableCount} waiting on you`}
              subtitle="Review approvals in your personal Activity inbox"
              leading={<Inbox className="h-4 w-4 text-warning-300" />}
              criticalStatus={
                <UnreadBadge tone="approval" contentSize="regular">
                  {actionableCount}
                </UnreadBadge>
              }
              onClick={onOpenActivity}
            />
          )}
          {hostIssues > 0 && (
            <OperationsItem
              title={`${hostIssues} host issue${hostIssues === 1 ? "" : "s"}`}
              subtitle="MCP authorization or refresh needs attention"
              leading={<ShieldAlert className="h-4 w-4 text-warning-300" />}
              onClick={onOpenHosts}
            />
          )}
        </ItemSection>
      )}
      <ItemSection
        label="Recent bots"
        action={
          <Button action="open" variant="ghost" controlSize="compact" onClick={onOpenAllBots}>
            View all
          </Button>
        }
        presentationLevel="medium"
        controlSize="regular"
      >
        {bots.slice(0, 6).map((bot) => (
          <BotRow key={bot.bot_id} bot={bot} onSelect={() => onOpenBot(bot.bot_id)} />
        ))}
      </ItemSection>
      <FleetAudit events={audit.slice(0, 8)} bots={bots} />
    </>
  );
}
