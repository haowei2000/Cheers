import { Inbox, ShieldAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { ItemSection, OperationsItem } from "@/components/ui/item";
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

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-sm bg-zinc-900/60 px-4 py-3">
      <p className="text-minimal uppercase tracking-[0.1em] text-zinc-400">{label}</p>
      <p className={cn("mt-1 text-comfortable font-semibold tabular-nums text-zinc-100", tone)}>{value}</p>
    </div>
  );
}

export function FleetOverview({
  summary,
  actionableCount,
  installationIssues,
  bots,
  audit,
  onOpenBot,
  onOpenAllBots,
  onOpenActivity,
  onOpenInstallations,
}: {
  summary: FleetSummary;
  actionableCount: number;
  installationIssues: number;
  bots: FleetBot[];
  audit: FleetAuditEvent[];
  onOpenBot: (botId: string) => void;
  onOpenAllBots: () => void;
  onOpenActivity: () => void;
  onOpenInstallations: () => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <SummaryCard label="Online" value={summary.online} />
        <SummaryCard label="Working" value={summary.working} tone="text-indigo-200" />
        <SummaryCard label="Offline" value={summary.offline} />
        <SummaryCard label="Waiting" value={summary.waiting} tone={summary.waiting ? "text-amber-300" : undefined} />
        <SummaryCard
          label="Install issues"
          value={installationIssues}
          tone={installationIssues ? "text-amber-300" : undefined}
        />
      </div>
      {(actionableCount > 0 || installationIssues > 0) && (
        <ItemSection label="Needs attention" presentationLevel="medium" controlSize="regular">
          {actionableCount > 0 && (
            <OperationsItem
              title={`${actionableCount} waiting on you`}
              subtitle="Review approvals in your personal Activity inbox"
              leading={<Inbox className="h-4 w-4 text-amber-300" />}
              criticalStatus={
                <UnreadBadge tone="approval" contentSize="regular">
                  {actionableCount}
                </UnreadBadge>
              }
              onClick={onOpenActivity}
            />
          )}
          {installationIssues > 0 && (
            <OperationsItem
              title={`${installationIssues} installation issue${installationIssues === 1 ? "" : "s"}`}
              subtitle="MCP authorization or refresh needs attention"
              leading={<ShieldAlert className="h-4 w-4 text-amber-300" />}
              onClick={onOpenInstallations}
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
