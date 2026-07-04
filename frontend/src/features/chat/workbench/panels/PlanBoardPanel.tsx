// ① Plan board — a session-scoped ViewBoard rendering the agent's live plan
// (channel.plan.read) as a status-grouped board (in_progress / pending / completed)
// with a completed/total progress bar per (bot, session). The ViewBoard wrapper owns
// the toolbar (title + session-scope badge + refresh) and fetch; this file only
// declares the verb + renders the data.
//
// SECURITY: every string here (entry content, bot/session ids) is agent-authored and
// UNTRUSTED — rendered as inert text only, never via dangerouslySetInnerHTML.
//
// v1 is READ-ONLY. TODO(phase-A follow-up): reorder entries + dispatch a re-plan/step
// to the owning bot (needs a write verb + drag handles here).
import { useMemo } from "react";
import { CircleDot, Circle, CheckCircle2, ClipboardList } from "lucide-react";
import { registerViewBoard, channelSessionParams } from "../viewBoard";

interface PlanEntry {
  content: string;
  priority?: string | null;
  status?: string | null;
}

interface BotPlan {
  bot_id: string;
  session_id: string;
  entries: PlanEntry[];
  total: number;
  completed: number;
  updated_at?: string | null;
}

interface PlanReadResponse {
  channel_id: string;
  plans: BotPlan[];
}

const GROUPS: { key: string; label: string }[] = [
  { key: "in_progress", label: "In progress" },
  { key: "pending", label: "Pending" },
  { key: "completed", label: "Completed" },
];

function groupFor(status?: string | null): string {
  if (status === "in_progress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending"; // pending + any unknown/missing status
}

function StatusIcon({ group }: { group: string }) {
  if (group === "in_progress")
    return <CircleDot className="w-3.5 h-3.5 flex-shrink-0 text-amber-400" />;
  if (group === "completed")
    return <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-emerald-500" />;
  return <Circle className="w-3.5 h-3.5 flex-shrink-0 text-zinc-600" />;
}

function PlanCard({ plan }: { plan: BotPlan }) {
  const grouped = useMemo(() => {
    const buckets: Record<string, PlanEntry[]> = {
      in_progress: [],
      pending: [],
      completed: [],
    };
    for (const e of plan.entries ?? []) buckets[groupFor(e.status)].push(e);
    return buckets;
  }, [plan.entries]);

  const total = plan.total || plan.entries?.length || 0;
  const completed = plan.completed || 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="border border-zinc-800 rounded-md mb-3 overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-2">
          <ClipboardList className="w-3.5 h-3.5 flex-shrink-0 text-zinc-500" />
          <span className="text-xs text-zinc-200 font-medium truncate" title={plan.bot_id}>
            {plan.bot_id.slice(0, 8)}
          </span>
          {plan.session_id ? (
            <span className="text-[10px] text-zinc-600 truncate" title={plan.session_id}>
              · {plan.session_id.slice(0, 8)}
            </span>
          ) : null}
          <div className="flex-1" />
          <span className="text-[11px] text-zinc-400 tabular-nums flex-shrink-0">
            {completed}/{total}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="p-2">
        {GROUPS.map((g) => {
          const items = grouped[g.key];
          if (items.length === 0) return null;
          return (
            <div key={g.key} className="mb-2 last:mb-0">
              <div className="px-1 mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                {g.label} · {items.length}
              </div>
              <ul className="space-y-0.5">
                {items.map((e, i) => (
                  <li
                    key={`${g.key}-${i}`}
                    className="flex items-start gap-1.5 px-1 py-0.5 text-xs text-zinc-300"
                  >
                    <span className="mt-0.5">
                      <StatusIcon group={g.key} />
                    </span>
                    {/* inert text — never dangerouslySetInnerHTML */}
                    <span
                      className={`flex-1 break-words ${
                        g.key === "completed" ? "text-zinc-500 line-through" : ""
                      }`}
                    >
                      {e.content}
                    </span>
                    {e.priority ? (
                      <span className="flex-shrink-0 text-[10px] text-zinc-600">{e.priority}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanBody({ data }: { data: PlanReadResponse }) {
  const plans = data.plans ?? [];
  if (plans.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-zinc-600">
        <ClipboardList className="w-5 h-5" />
        <span className="text-xs">No plan yet</span>
        <span className="text-[11px] text-zinc-700">
          A plan appears here when an agent shares one.
        </span>
      </div>
    );
  }
  return (
    <div className="p-3">
      {plans.map((p) => (
        <PlanCard key={`${p.bot_id}:${p.session_id}`} plan={p} />
      ))}
    </div>
  );
}

registerViewBoard<PlanReadResponse>({
  id: "plan",
  title: "Plan",
  icon: ClipboardList,
  verb: "channel.plan.read",
  sessionScoped: true,
  makeParams: channelSessionParams,
  render: (data) => <PlanBody data={data} />,
});
