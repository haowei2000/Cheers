// Activity feed — a ViewBoard over channel.activity.read (messages ∪ channel
// operations, the Class-1 event stream interleaved by channel_seq). Latest-first
// (desc), channel-wide. Live-pushed: a new message bumps the "activity" tick so the
// feed refetches without a manual refresh. All content renders as inert text.
import { Activity, MessageSquare, Cog } from "lucide-react";
import { registerViewBoard } from "../viewBoard";

interface ActivityEvent {
  event_type: "message" | "operation" | string;
  channel_seq: number;
  created_at?: string | null;
  data: Record<string, unknown>;
}
interface ActivityRead {
  channel_id: string;
  events: ActivityEvent[];
}

function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function truncate(s: string, n = 140): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function short(id: unknown): string {
  return typeof id === "string" ? id.slice(0, 8) : "";
}

function MessageRow({ d }: { d: Record<string, unknown> }) {
  const sender = `${d.sender_type ?? "?"} ${short(d.sender_id)}`.trim();
  const content = typeof d.content === "string" ? d.content : "";
  const kind = typeof d.msg_type === "string" && d.msg_type !== "text" ? d.msg_type : null;
  return (
    <div className="flex items-start gap-2">
      <MessageSquare className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-sky-500/70" />
      <div className="min-w-0">
        <span className="text-zinc-400 font-mono text-[11px]">{sender}</span>
        {kind && (
          <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-500">{kind}</span>
        )}
        {/* inert text */}
        <div className="text-zinc-300 break-words">{truncate(content)}</div>
      </div>
    </div>
  );
}

function OperationRow({ d }: { d: Record<string, unknown> }) {
  const actor = `${d.actor_type ?? "?"} ${short(d.actor_id)}`.trim();
  const op = typeof d.op_type === "string" ? d.op_type : "operation";
  const target = typeof d.target_ref === "string" ? d.target_ref : "";
  return (
    <div className="flex items-start gap-2">
      <Cog className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-zinc-600" />
      <div className="min-w-0 text-zinc-400">
        <span className="font-mono text-zinc-300">{op}</span>
        {target && <span className="text-zinc-500"> · {target}</span>}
        <span className="text-[11px] text-zinc-600"> · {actor}</span>
      </div>
    </div>
  );
}

function ActivityBody({ data }: { data: ActivityRead }) {
  const events = data.events ?? [];
  if (events.length === 0) {
    return (
      <div className="px-3 py-6 text-xs text-zinc-600 flex items-center gap-2">
        <Activity className="w-4 h-4" />
        No activity yet
      </div>
    );
  }
  return (
    <ul className="text-xs divide-y divide-zinc-900">
      {events.map((e) => (
        <li key={`${e.event_type}-${e.channel_seq}`} className="px-3 py-2">
          <div className="flex items-baseline justify-between gap-2 mb-0.5">
            <span className="text-[10px] text-zinc-600 tabular-nums">#{e.channel_seq}</span>
            <span className="text-[10px] text-zinc-600 tabular-nums">{fmtTime(e.created_at)}</span>
          </div>
          {e.event_type === "operation" ? <OperationRow d={e.data} /> : <MessageRow d={e.data} />}
        </li>
      ))}
    </ul>
  );
}

registerViewBoard<ActivityRead>({
  id: "activity",
  title: "Activity",
  icon: Activity,
  verb: "channel.activity.read",
  sessionScoped: false,
  // Latest-first, channel-wide feed (activity is channel-level, not session-scoped).
  makeParams: (ctx) => ({ channel_id: ctx.channelId, limit: 50, desc: true }),
  render: (data) => <ActivityBody data={data} />,
});
