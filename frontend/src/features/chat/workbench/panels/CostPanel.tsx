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
  if (bots.length === 0) {
    return (
      <div className="px-3 py-6 text-compact text-content-muted flex items-center gap-2">
        <Gauge className="w-4 h-4" />
        No usage reported yet
      </div>
    );
  }
  return (
    <table className="w-full text-compact">
      <thead>
        <tr className="text-content-muted border-b border-zinc-800">
          <th className="text-left font-normal px-3 py-2">Bot</th>
          <th className="text-left font-normal px-2 py-2">Session</th>
          <th className="text-right font-normal px-2 py-2">Input</th>
          <th className="text-right font-normal px-2 py-2">Output</th>
          <th className="text-right font-normal px-2 py-2">Total</th>
          <th className="text-right font-normal px-2 py-2">Context</th>
          <th className="text-right font-normal px-3 py-2">Cost</th>
        </tr>
      </thead>
      <tbody>
        {bots.map((b) => (
          <tr
            key={`${b.bot_id}:${b.session_id ?? "—"}`}
            className="border-b border-zinc-900 hover:bg-zinc-800/40 text-content-secondary"
          >
            {/* Bot reads as avatar + name (full id in the tooltip); session_id is an
                opaque technical id: short mono form + tooltip. */}
            <td className="px-3 py-2 text-content-secondary max-w-[130px]" title={b.bot_id}>
              <span className="flex items-center gap-2 min-w-0">
                <Avatar
                  name={memberLabel(members, b.bot_id)}
                  src={members.get(b.bot_id)?.avatar_url ?? undefined}
                  id={b.bot_id}
                  size="small"
                />
                <span className="truncate">{memberLabel(members, b.bot_id)}</span>
              </span>
            </td>
            <td
              className="px-2 py-2 font-code text-content-muted truncate max-w-[90px]"
              title={b.session_id ?? undefined}
            >
              {b.session_id ? b.session_id.slice(0, 8) : "—"}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-content-muted">
              {fmtInt(b.input_tokens)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-content-muted">
              {fmtInt(b.output_tokens)}
            </td>
            <td className="px-2 py-2 text-right tabular-nums text-content-secondary">
              {fmtInt(b.total_tokens)}
            </td>
            {/* context window = latest snapshot; an at-a-glance pressure gauge */}
            <td className="px-2 py-2 text-right tabular-nums">
              <span className="inline-flex items-center gap-1 text-content-muted">
                <Gauge className="w-3.5 h-3.5 text-content-muted" />
                {fmtInt(b.context_window)}
              </span>
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-success-400">
              {fmtUsd(b.cost_usd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
