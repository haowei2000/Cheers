import { useRef, useState } from "react";
import {
  Plus,
  Check,
  X,
  ListChecks,
  FileText,
  MessageSquare,
  Activity,
  Boxes,
  DollarSign,
  type LucideIcon,
} from "lucide-react";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import {
  useContextPickStore,
  usePendingContext,
  type ContextItem,
} from "./contextPick";

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

/** Read-only chips for a sent message's attached context (rendered in MessageItem). */
export function MessageContextChips({
  bundle,
  className,
}: {
  bundle: { items?: Array<{ label: string; kind: string }> } | null | undefined;
  className?: string;
}) {
  const items = bundle?.items ?? [];
  if (!items.length) return null;
  return (
    <div className={`flex items-center flex-wrap gap-1.5 ${className ?? ""}`}>
      {items.map((it, i) => {
        const Icon = iconFor(it.kind);
        return (
          <span
            key={`${it.kind}:${it.label}:${i}`}
            className="inline-flex items-center gap-1 rounded-lg bg-zinc-800/60 px-2 py-0.5 text-[11px] text-zinc-400"
            title={`Attached context: ${it.label}`}
          >
            <Icon className="w-3 h-3" />
            <span className="max-w-[12rem] truncate">{it.label}</span>
          </span>
        );
      })}
    </div>
  );
}

// v1 quick attaches: channel-scoped Viewboard resources (one click, no browsing).
// File / message picking and in-panel attach arrive in the next slice.
const QUICK: ContextItem[] = [
  { id: "plan", verb: "channel.plan.read", params: {}, label: "Plan", kind: "plan" },
  {
    id: "activity",
    verb: "channel.activity.read",
    params: {},
    label: "Recent decisions",
    kind: "activity",
  },
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
      title={disabled ? disabledTitle ?? "Unavailable" : added ? "Added to context" : title}
      className={
        className ??
        "rounded p-0.5 text-zinc-500 hover:text-indigo-300 disabled:opacity-40 disabled:hover:text-zinc-500"
      }
    >
      {added ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Plus className="w-3.5 h-3.5" />}
    </button>
  );
}

export function ContextPickBar({ channelId }: { channelId: string }) {
  const items = usePendingContext(channelId);
  const add = useContextPickStore((s) => s.add);
  const remove = useContextPickStore((s) => s.remove);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  return (
    <div className="flex items-center flex-wrap gap-1.5 px-4 py-1.5 border-t border-zinc-800">
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
          title="Attach Cheers resources (plan, decisions, …) as context for this message"
          className="inline-flex items-center gap-1 rounded-lg bg-zinc-800/60 px-2 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add context
        </button>
        {open && (
          <PopoverPanel placement="up" align="start" className="w-52 p-1">
            <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-400">
              Attach to this message
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
          </PopoverPanel>
        )}
      </div>
    </div>
  );
}
