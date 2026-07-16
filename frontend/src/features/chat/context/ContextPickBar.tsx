import { useRef, useState } from "react";
import {
  MessageSquarePlus,
  Check,
  X,
  ListChecks,
  FileText,
  MessageSquare,
  Activity,
  Boxes,
  DollarSign,
  CornerDownRight,
  type LucideIcon,
} from "lucide-react";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import {
  useContextPickStore,
  usePendingContext,
  useContextSuggestions,
  type ContextItem,
  type ReplyTargetLike,
  type FileRef,
} from "./contextPick";
import {
  ADD_CONTEXT_MENU,
  ADD_CONTEXT_MENU_TITLE,
  ADDED_TO_CONTEXT_TITLE,
} from "./contextLabels";

// Composer "add context" bar (docs/design/RESOURCE_CONTEXT.md, F1): renders the
// pending resource picks as removable chips and an "add context" menu. In-panel
// "attach" affordances (Viewboard / Workbench) push to the same store.

const KIND_ICON: Record<ContextItem["kind"], LucideIcon> = {
  plan: ListChecks,
  file: FileText,
  message: MessageSquare,
  activity: Activity,
  sessions: Boxes,
  cost: DollarSign,
};

function iconFor(kind: string): LucideIcon {
  return KIND_ICON[kind as ContextItem["kind"]] ?? FileText;
}

/** Read-only chips for a message's attached context (rendered in MessageItem).
 *  Two origins: a human's manual pick renders as plain chips; a bot@bot handoff
 *  (origin="handoff") renders a labeled "↪ Received handoff" card so the automatic
 *  context hand-off is visible in chat, not just delivered to the agent. */
export function MessageContextChips({
  bundle,
  className,
}: {
  bundle:
    | { origin?: string; items?: Array<{ label: string; kind: string }> }
    | null
    | undefined;
  className?: string;
}) {
  const items = bundle?.items ?? [];
  if (!items.length) return null;
  const isHandoff = bundle?.origin === "handoff";
  const chips = items.map((it, i) => {
    const Icon = iconFor(it.kind);
    return (
      <span
        key={`${it.kind}:${it.label}:${i}`}
        className="inline-flex items-center gap-1 rounded-lg bg-zinc-800/60 px-2 py-0.5 text-[11px] text-zinc-400"
        title={`${isHandoff ? "Handed off" : "Attached"} context: ${it.label}`}
      >
        <Icon className="w-3 h-3" />
        <span className="max-w-[12rem] truncate">{it.label}</span>
      </span>
    );
  });
  if (isHandoff) {
    return (
      <div
        className={`flex items-center flex-wrap gap-1.5 rounded-lg bg-indigo-600/10 px-2 py-1 ${className ?? ""}`}
      >
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-300">
          <CornerDownRight className="w-3 h-3" />
          Received handoff
        </span>
        {chips}
      </div>
    );
  }
  return (
    <div className={`flex items-center flex-wrap gap-1.5 ${className ?? ""}`}>
      {chips}
    </div>
  );
}

// Quick attaches = the CHANNEL-SCOPED reads that need no target to pick (one click,
// no browsing): plan, recent decisions, sessions, cost. The remaining context kinds
// need a specific target — a file (Workbench), a message (reply), or a remote-
// workspace file (RemoteWorkspace dialog) — so they attach from their own panels,
// not this menu. (Keep in sync with the readable channel verbs in the resource
// registry + the sanitize allowlist.)
const QUICK: ContextItem[] = [
  { id: "plan", verb: "channel.plan.read", params: {}, label: "Plan", kind: "plan" },
  {
    id: "activity",
    verb: "channel.activity.read",
    params: {},
    label: "Recent decisions",
    kind: "activity",
  },
  { id: "sessions", verb: "channel.sessions.read", params: {}, label: "Sessions", kind: "sessions" },
  { id: "cost", verb: "channel.usage.read", params: {}, label: "Cost", kind: "cost" },
];

/** In-panel "attach this to my next message" button (Viewboard / Workbench /
 *  a message). Pushes one item to the channel's pending context; shows a check
 *  once added. `disabled` (e.g. an already-pinned file) blocks the attach. */
export function AttachContextButton({
  channelId,
  item,
  title,
  disabled,
  disabledTitle,
  className,
}: {
  channelId: string;
  item: ContextItem;
  title: string;
  disabled?: boolean;
  disabledTitle?: string;
  className?: string;
}) {
  const add = useContextPickStore((s) => s.add);
  const added = useContextPickStore((s) =>
    (s.byChannel[channelId] ?? []).some((i) => i.id === item.id)
  );
  return (
    <button
      type="button"
      disabled={disabled || added}
      onClick={() => add(channelId, item)}
      title={disabled ? disabledTitle ?? "Unavailable" : added ? ADDED_TO_CONTEXT_TITLE : title}
      className={
        className ??
        "rounded p-0.5 text-zinc-500 hover:text-indigo-300 disabled:opacity-40 disabled:hover:text-zinc-500"
      }
    >
      {added ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <MessageSquarePlus className="w-3.5 h-3.5" />}
    </button>
  );
}

export function ContextPickBar({
  channelId,
  replyTo,
  draftText,
  files,
}: {
  channelId: string;
  replyTo?: ReplyTargetLike | null;
  draftText?: string;
  files?: FileRef[];
}) {
  const items = usePendingContext(channelId);
  const suggestions = useContextSuggestions(channelId, { replyTo, draftText, files });
  const add = useContextPickStore((s) => s.add);
  const remove = useContextPickStore((s) => s.remove);
  const dismissSuggestion = useContextPickStore((s) => s.dismissSuggestion);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  return (
    <div className="flex items-center flex-wrap gap-1.5 px-4 py-1.5 border-t border-zinc-800">
      {/* Suggested context (F3): one-click to add, one-click to dismiss; never
          auto-committed. Rendered as dashed "ghost" chips, distinct from picks. */}
      {suggestions.map((sg) => {
        const Icon = KIND_ICON[sg.kind];
        return (
          <span
            key={`sg:${sg.id}`}
            className="inline-flex items-center gap-1 rounded-lg border border-dashed border-zinc-700 pl-1 pr-1 py-0.5 text-[11px] text-zinc-500"
          >
            <button
              type="button"
              onClick={() => add(channelId, sg)}
              title={`Suggested: add "${sg.label}" as context`}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-indigo-300"
            >
              <Icon className="w-3 h-3" />
              <span className="max-w-[12rem] truncate">{sg.label}</span>
              <MessageSquarePlus className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => dismissSuggestion(channelId, sg.id)}
              aria-label={`Dismiss suggestion ${sg.label}`}
              title="Dismiss suggestion"
              className="rounded p-0.5 text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}

      {items.map((it) => {
        const Icon = KIND_ICON[it.kind];
        return (
          <span
            key={it.id}
            className="inline-flex items-center gap-1 rounded-lg bg-zinc-800/60 pl-2 pr-1 py-1 text-[11px] text-zinc-300"
          >
            <Icon className="w-3 h-3 text-zinc-400" />
            <span className="max-w-[12rem] truncate">{it.label}</span>
            <button
              type="button"
              onClick={() => remove(channelId, it.id)}
              aria-label={`Remove ${it.label}`}
              title="Remove"
              className="ml-0.5 rounded p-0.5 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}

      <div ref={rootRef} className="relative inline-flex">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={ADD_CONTEXT_MENU_TITLE}
          className="inline-flex items-center gap-1 rounded-lg bg-zinc-800/60 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
        >
          <MessageSquarePlus className="w-3 h-3" />
          {ADD_CONTEXT_MENU}
        </button>
        {open && (
          <PopoverPanel placement="up" align="start" className="w-56 p-1">
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
              Add to context
            </p>
            {QUICK.map((q) => {
              const Icon = KIND_ICON[q.kind];
              const already = items.some((i) => i.id === q.id);
              return (
                <button
                  key={q.id}
                  type="button"
                  disabled={already}
                  onClick={() => {
                    add(channelId, q);
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Icon className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="flex-1 text-left">{q.label}</span>
                  {already && <span className="text-[10px] text-zinc-500">added</span>}
                </button>
              );
            })}
            <p className="px-2 pt-1.5 pb-0.5 text-[10px] text-zinc-500 border-t border-zinc-800 mt-1">
              Files, messages & a bot's workspace files: add them from their own
              panels (Workbench, a reply, the Remote workspace).
            </p>
          </PopoverPanel>
        )}
      </div>
    </div>
  );
}
