import { Button as UiButton } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
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
  ArrowUpRight,
  PanelRight,
  FolderTree,
  type LucideIcon,
} from "lucide-react";
import { PopoverPanel, usePopoverDismiss } from "@/components/ui/popover";
import { ItemChip } from "@/components/ui/item";
import { controlHeightClasses } from "@/components/ui/control-size";
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
      <ItemChip
        key={`${it.kind}:${it.label}:${i}`}
        leading={<Icon className="w-3.5 h-3.5" />}
        label={it.label}
        className="max-w-[14rem]"
      />
    );
  });
  if (isHandoff) {
    return (
      <div
        className={`flex items-center flex-wrap gap-2 rounded-sm bg-indigo-600/10 px-2 py-1 ${className ?? ""}`}
      >
        <span className="inline-flex items-center gap-1 text-compact font-medium text-indigo-300">
          <CornerDownRight className="w-3.5 h-3.5" />
          Received handoff
        </span>
        {chips}
      </div>
    );
  }
  return (
    <div className={`flex items-center flex-wrap gap-2 ${className ?? ""}`}>
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

/** Which surface a pending context item can be jumped back to — a workbench
 *  file (`fs.read`) opens the Workbench focused on it; a bot's workspace file
 *  (`workspace.read`) opens the Remote workspace dialog at that path. Anything
 *  else (channel reads: plan/activity/sessions/cost) has no file to jump to. */
export function jumpTargetOf(it: ContextItem): "workbench" | "workspace" | null {
  if (it.verb === "fs.read") return "workbench";
  if (it.verb === "workspace.read") return "workspace";
  return null;
}

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
    <UiButton variant="plain"
      type="button"
      square
      controlSize="compact"
      disabled={disabled || added}
      onClick={() => add(channelId, item)}
      title={disabled ? disabledTitle ?? "Unavailable" : added ? ADDED_TO_CONTEXT_TITLE : title}
      className={
 className ??
 "rounded-sm text-zinc-500 hover:text-indigo-300 disabled:opacity-40 disabled:hover:text-zinc-500"}
    >
      {added ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <MessageSquarePlus className="w-3.5 h-3.5" />}
    </UiButton>
  );
}

export function ContextPickBar({
  channelId,
  replyTo,
  draftText,
  files,
  onBrowseWorkbench,
  onBrowseWorkspace,
  onJumpToSource,
}: {
  channelId: string;
  replyTo?: ReplyTargetLike | null;
  draftText?: string;
  files?: FileRef[];
  /** Open the Workbench drawer so the user can pick a file to attach. */
  onBrowseWorkbench?: () => void;
  /** Open the Remote workspace dialog so the user can pick a workspace file. */
  onBrowseWorkspace?: () => void;
  /** Jump to a pending item's source (Workbench file / workspace file). */
  onJumpToSource?: (item: ContextItem) => void;
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
    <div className="mx-auto mt-1 flex w-full max-w-[72rem] items-center flex-wrap gap-2 px-4 py-2 max-md:px-3">
      {/* Suggested context (F3): one-click to add, one-click to dismiss; never
          auto-committed. Rendered as dashed "ghost" chips, distinct from picks. */}
      {suggestions.map((sg) => {
        const Icon = KIND_ICON[sg.kind];
        return (
          <span
            key={`sg:${sg.id}`}
            className={`inline-flex items-center gap-1 rounded-sm bg-zinc-800/50 px-1 text-zinc-500 ${controlHeightClasses.regular}`}
          >
            <UiButton variant="plain"
              type="button"
              onClick={() => add(channelId, sg)}
              title={`Suggested: add "${sg.label}" as context`}
              controlSize="compact" className="min-w-0 flex-1 hover:text-indigo-300"
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="max-w-[12rem] truncate">{sg.label}</span>
              <MessageSquarePlus className="w-3.5 h-3.5" />
            </UiButton>
            <IconButton
              onClick={() => dismissSuggestion(channelId, sg.id)}
              label={`Dismiss suggestion ${sg.label}`}
              title="Dismiss suggestion"
              controlSize="compact"
              className="text-zinc-600 hover:text-zinc-300 hover:bg-zinc-700"
            >
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </span>
        );
      })}

      {items.map((it) => {
        const Icon = KIND_ICON[it.kind];
        const jumpTo = onJumpToSource && jumpTargetOf(it);
        return (
          <ItemChip
            key={it.id}
            label={it.label}
            leading={<Icon className="h-4 w-4 flex-shrink-0 text-zinc-400" />}
            presentationLevel="max"
            controlSize="regular"
            className="bg-zinc-800/60 text-regular text-zinc-300"
            actions={
              <>
                {jumpTo && (
                  <IconButton
                    onClick={() => onJumpToSource(it)}
                    label={`Open ${it.label} in the ${jumpTo === "workbench" ? "Workbench" : "workspace"}`}
                    title={`Open in ${jumpTo === "workbench" ? "Workbench" : "Remote workspace"}`}
                    controlSize="compact"
                    className="text-zinc-500 hover:bg-zinc-700 hover:text-indigo-300"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </IconButton>
                )}
                <IconButton
                  onClick={() => remove(channelId, it.id)}
                  label={`Remove ${it.label}`}
                  title="Remove"
                  controlSize="compact"
                  className="text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </>
            }
          />
        );
      })}

      <div ref={rootRef} className="relative inline-flex">
        <UiButton variant="plain"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={ADD_CONTEXT_MENU_TITLE}
          controlSize="regular" className="gap-2 bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <MessageSquarePlus className="h-4 w-4" />
          {ADD_CONTEXT_MENU}
        </UiButton>
        {open && (
          <PopoverPanel placement="up" align="start" className="w-56 p-1">
            <p className="px-2 py-1 text-minimal uppercase tracking-wide text-zinc-400">
              Add to context
            </p>
            {QUICK.map((q) => {
              const Icon = KIND_ICON[q.kind];
              const already = items.some((i) => i.id === q.id);
              return (
                <UiButton controlWidth="fill" variant="plain"
                  key={q.id}
                  type="button"
                  disabled={already}
                  onClick={() => {
                    add(channelId, q);
                    setOpen(false);
                  }}
                  controlSize="regular" className="flex items-center gap-2 rounded-sm text-regular text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  <Icon className="w-3.5 h-3.5 text-zinc-400" />
                  <span className="flex-1 text-left">{q.label}</span>
                  {already && <span className="text-minimal text-zinc-500">added</span>}
                </UiButton>
              );
            })}
            {(onBrowseWorkbench || onBrowseWorkspace) && (
              <>
                <p className="px-2 pt-2 pb-1 text-minimal uppercase tracking-wide text-zinc-400 border-t border-zinc-800 mt-1">
                  Browse &amp; attach
                </p>
                {onBrowseWorkbench && (
                  <UiButton controlWidth="fill" variant="plain"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onBrowseWorkbench();
                    }}
                    title="Open the Workbench to pick a file to attach"
                    controlSize="regular" className="flex items-center gap-2 rounded-sm text-regular text-zinc-300 hover:bg-zinc-800"
                  >
                    <PanelRight className="w-3.5 h-3.5 text-zinc-400" />
                    <span className="flex-1 text-left">Workbench files…</span>
                    <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
                  </UiButton>
                )}
                {onBrowseWorkspace && (
                  <UiButton controlWidth="fill" variant="plain"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onBrowseWorkspace();
                    }}
                    title="Open the Remote workspace to pick a file to attach"
                    controlSize="regular" className="flex items-center gap-2 rounded-sm text-regular text-zinc-300 hover:bg-zinc-800"
                  >
                    <FolderTree className="w-3.5 h-3.5 text-zinc-400" />
                    <span className="flex-1 text-left">Workspace files…</span>
                    <ArrowUpRight className="w-3.5 h-3.5 text-zinc-500" />
                  </UiButton>
                )}
              </>
            )}
            <p className="px-2 pt-2 pb-1 text-minimal text-zinc-500">
              Or attach a message from its reply action.
            </p>
          </PopoverPanel>
        )}
      </div>
    </div>
  );
}
