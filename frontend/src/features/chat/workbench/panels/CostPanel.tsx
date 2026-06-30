// ② Cost dashboard — a session-scoped ViewBoard: per-bot token/cost totals + latest
// context window (channel.usage.read). The ViewBoard wrapper owns the toolbar (title +
// session-scope badge + refresh) and fetch; this file declares the verb + renders rows.
//
// All numbers come from the agent's own usage_update telemetry and are rendered as
// INERT TEXT (formatted numbers / JSX children) — never as HTML.
//
// FOLLOW-UP (out of scope here): the chain-budget pause-gate (block a turn when a
// channel's cumulative cost crosses a cap) lives in shared dispatch, not this read
// panel; wire it where turns are admitted, not in the dashboard.
import { Coins, Gauge } from "lucide-react";
import { registerViewBoard, channelSessionParams } from "../viewBoard";

interface BotUsage {
  bot_id: string;
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

function UsageBody({ data }: { data: UsageRead }) {
  const bots = data.bots ?? [];
  if (bots.length === 0) {
    return (
      <div className="px-3 py-6 text-xs text-zinc-600 flex items-center gap-2">
        <Gauge className="w-4 h-4" />
        No usage reported yet
      </div>
    );
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-zinc-500 border-b border-zinc-800">
          <th className="text-left font-normal px-3 py-1.5">Bot</th>
          <th className="text-right font-normal px-2 py-1.5">Input</th>
          <th className="text-right font-normal px-2 py-1.5">Output</th>
          <th className="text-right font-normal px-2 py-1.5">Total</th>
          <th className="text-right font-normal px-2 py-1.5">Context</th>
          <th className="text-right font-normal px-3 py-1.5">Cost</th>
        </tr>
      </thead>
      <tbody>
        {bots.map((b) => (
          <tr
            key={b.bot_id}
            className="border-b border-zinc-900 hover:bg-zinc-800/40 text-zinc-300"
          >
            {/* bot_id is an opaque id, rendered as inert text */}
            <td className="px-3 py-1.5 font-mono text-zinc-200 truncate max-w-[140px]">
              {b.bot_id}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">
              {fmtInt(b.input_tokens)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">
              {fmtInt(b.output_tokens)}
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-zinc-200">
              {fmtInt(b.total_tokens)}
            </td>
            {/* context window = latest snapshot; an at-a-glance pressure gauge */}
            <td className="px-2 py-1.5 text-right tabular-nums">
              <span className="inline-flex items-center gap-1 text-zinc-400">
                <Gauge className="w-3 h-3 text-zinc-600" />
                {fmtInt(b.context_window)}
              </span>
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
              {fmtUsd(b.cost_usd)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

registerViewBoard<UsageRead>({
  id: "cost",
  title: "Cost",
  icon: Coins,
  verb: "channel.usage.read",
  sessionScoped: true,
  makeParams: channelSessionParams,
  render: (data) => <UsageBody data={data} />,
});
