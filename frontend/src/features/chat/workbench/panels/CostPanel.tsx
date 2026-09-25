// ② Cost dashboard — a session-scoped ViewBoard: per-(bot, session) token/cost totals +
// latest context window (channel.usage.read). With the host's scope set to "All sessions"
// each session is its own row, so you can compare usage across a bot's sessions; scoped to
// one session it shows just that row. The host owns the toolbar (title + scope + refresh).
//
// All numbers come from the agent's own usage_update telemetry and are rendered as
// INERT TEXT (formatted numbers / JSX children) — never as HTML.
//
// FOLLOW-UP (out of scope here): the chain-budget pause-gate (block a turn when a
// channel's cumulative cost crosses a cap) lives in shared dispatch, not this read
// panel; wire it where turns are admitted, not in the dashboard.
import { Coins, Gauge } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { type PanelContext } from "@/features/chat/panels/registry";
import { registerDataPanel, channelSessionParams } from "@/features/chat/panels/definePanel";
import { useMembersIndex, memberLabel } from "../useMembersIndex";

interface BotUsage {
  bot_id: string;
  session_id?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  context_window: number | null;
  cost_usd: number | null;
}
interface UsageRead {
  channel_id: string;
  bots: BotUsage[];
}

// Inert formatters: thousands-separated integers and a USD amount. A missing value
// renders as an em dash rather than "0", so "no data" reads differently from
// "measured zero".
function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function UsageBody({ data, ctx }: { data: UsageRead; ctx: PanelContext }) {
  // bot_id → member, so the Bot column reads as avatar + name, not a raw uuid.
  const members = useMembersIndex(ctx.channelId);
  const bots = data.bots ?? [];
  const columns: DataTableColumn<BotUsage>[] = [
    {
      id: "bot",
      header: "Bot",
      sortValue: (bot) => memberLabel(members, bot.bot_id),
      className: "max-w-[130px]",
      cell: (bot) => (
        <span title={bot.bot_id}>
          <span className="flex items-center gap-2 min-w-0">
            <Avatar
              name={memberLabel(members, bot.bot_id)}
              src={members.get(bot.bot_id)?.avatar_url ?? undefined}
              id={bot.bot_id}
              size="small"
            />
            <span className="truncate">{memberLabel(members, bot.bot_id)}</span>
          </span>
        </span>
      ),
    },
    {
      id: "session",
      header: "Session",
      sortValue: (bot) => bot.session_id,
      className: "max-w-[90px] truncate font-code text-content-muted",
      cell: (bot) => <span title={bot.session_id ?? undefined}>{bot.session_id ? bot.session_id.slice(0, 8) : "—"}</span>,
    },
    { id: "input", header: "Input", align: "right", sortValue: (bot) => bot.input_tokens, className: "tabular-nums text-content-muted", cell: (bot) => fmtInt(bot.input_tokens) },
    { id: "output", header: "Output", align: "right", sortValue: (bot) => bot.output_tokens, className: "tabular-nums text-content-muted", cell: (bot) => fmtInt(bot.output_tokens) },
    { id: "total", header: "Total", align: "right", sortValue: (bot) => bot.total_tokens, className: "tabular-nums text-content-secondary", cell: (bot) => fmtInt(bot.total_tokens) },
    {
      id: "context",
      header: "Context",
      align: "right",
      sortValue: (bot) => bot.context_window,
      className: "tabular-nums",
      cell: (bot) => (
        <span className="inline-flex items-center gap-1 text-content-muted">
          <Gauge className="w-3.5 h-3.5 text-content-muted" />
          {fmtInt(bot.context_window)}
        </span>
      ),
    },
    { id: "cost", header: "Cost", align: "right", sortValue: (bot) => bot.cost_usd, className: "tabular-nums text-success-400", cell: (bot) => fmtUsd(bot.cost_usd) },
  ];
  return (
    <DataTable
      label="Usage by bot and session"
      columns={columns}
      rows={bots}
      getRowKey={(bot) => `${bot.bot_id}:${bot.session_id ?? "—"}`}
      initialSort={{ columnId: "total", direction: "descending" }}
      emptyIcon={Gauge}
      emptyTitle="No usage reported yet"
      emptyHint="Usage appears after an agent reports its first token update."
    />
  );
}

registerDataPanel<UsageRead>({
  id: "cost",
  title: "Cost",
  icon: Coins,
  source: { kind: "resource", verb: "channel.usage.read", params: channelSessionParams },
  scope: "session",
  render: (data, ctx) => <UsageBody data={data} ctx={ctx} />,
});
