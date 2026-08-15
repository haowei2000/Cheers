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
import { Avatar } from "@/components/ui/avatar";
import { ItemList, WorkbenchItem } from "@/components/ui/item";
import { registerViewBoard, channelSessionParams, type ViewBoardContext } from "../viewBoard";
import { useMembersIndex, memberLabel, type MembersIndex } from "../useMembersIndex";

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
    return <CircleDot className="w-3.5 h-3.5 flex-shrink-0 text-warning-400" />;
  if (group === "completed")
    return <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 text-success-500" />;
  return <Circle className="w-3.5 h-3.5 flex-shrink-0 text-content-muted" />;
}

function PlanCard({ plan, members }: { plan: BotPlan; members: MembersIndex }) {
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
    <div className="rounded-sm mb-3 overflow-hidden">
      <div className="mx-2 mt-2 rounded-sm bg-zinc-900/60 px-3 py-2">
        <div className="flex items-center gap-2">
          {/* Card is titled by the bot's avatar + name (raw id in the tooltip). */}
          <Avatar
            name={memberLabel(members, plan.bot_id)}
            src={members.get(plan.bot_id)?.avatar_url ?? undefined}
            id={plan.bot_id}
            size="small"
          />
          <span className="text-compact text-content-secondary font-medium truncate" title={plan.bot_id}>
            {memberLabel(members, plan.bot_id)}
          </span>
          {plan.session_id ? (
            <span className="text-minimal text-content-muted truncate" title={plan.session_id}>
              · {plan.session_id.slice(0, 8)}
            </span>
          ) : null}
          <div className="flex-1" />
          <span className="text-compact text-content-muted tabular-nums flex-shrink-0">
            {completed}/{total}
          </span>
        </div>
        <div data-design-system-exempt="progress" className="mt-2 h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
          <div
            data-design-system-exempt="progress"
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
              <div className="px-1 mb-1 text-minimal uppercase tracking-label text-content-muted">
                {g.label} · {items.length}
              </div>
              <ItemList presentationLevel="medium" controlSize="regular">
                {items.map((e, i) => (
                  <WorkbenchItem
                    key={`${g.key}-${i}`}
                    title={e.content}
                    leading={<StatusIcon group={g.key} />}
                    trailing={e.priority ? <span className="text-minimal text-content-muted">{e.priority}</span> : undefined}
                    presentationLevel="minimal"
                    className={g.key === "completed"? "border-0 text-content-muted line-through" : "border-0"}
                  />
                ))}
              </ItemList>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanBody({ data, ctx }: { data: PlanReadResponse; ctx: ViewBoardContext }) {
  const members = useMembersIndex(ctx.channelId);
  const plans = data.plans ?? [];
  if (plans.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-content-muted">
        <ClipboardList className="w-5 h-5" />
        <span className="text-compact text-content-muted">No plan yet</span>
        <span className="text-compact text-content-muted">
          A plan appears here when an agent shares one.
        </span>
      </div>
    );
  }
  return (
    <div className="p-3">
      {plans.map((p) => (
        <PlanCard key={`${p.bot_id}:${p.session_id}`} plan={p} members={members} />
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
  render: (data, ctx) => <PlanBody data={data} ctx={ctx} />,
});
