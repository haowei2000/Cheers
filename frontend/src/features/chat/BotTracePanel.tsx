import { Button as UiButton } from "@/components/ui/button";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  ChevronDown,
  Wrench,
  ListTodo,
  ShieldCheck,
  Check,
  X,
  XCircle,
  Clock,
  Zap,
  Loader2,
  FileSearch,
  Pencil,
  FilePlus2,
  Terminal,
  Search,
  GitBranch,
  GitCommit,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { fetchMessageTrace } from "@/api/approval";
import { FloatingPanel } from "@/components/ui/floating-panel";
import type { Message, PermissionContentData, TraceEvent } from "@/types";
import { DiffView } from "./DiffView";
import {
  aggregateDiffStats,
  diffStats,
  fileDiffPreview,
  fileDiffsFromData,
  formatDiffDelta,
  pathBasename,
  type FileDiff,
} from "./fileEditDiff";
import { PermissionCard } from "./PermissionCard";
import { coalesceTraceEvents } from "./traceEvent";
import {
  parseGitStatusResult,
  toolPresentationFromTrace,
  type ToolEventType,
  type ToolPresentation,
} from "./toolPresentation";

interface Props {
  channelId: string;
  msgId: string;
  liveEvents?: TraceEvent[];
  /** Pending permission messages anchored to this bot turn. */
  pendingApprovals?: Message[];
  currentUserId?: string;
  /** True while the bot turn is still streaming / partial — show only the latest step. */
  streaming?: boolean;
  /** Deep-link: expand and focus the approval with this request_id. */
  focusRequestId?: string | null;
  /** Controlled disclosure state when Agent steps live inside message Details. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** False when the parent message renders the unified Details trigger. */
  showToggle?: boolean;
}

type EventVisual = { Icon: LucideIcon; tone: string; label: string };

// The Gateway event type is the only tool-display routing input. Adding a new
// visual treatment requires a new backend event type and an explicit entry here.
const TOOL_EVENT_META: Record<ToolEventType, EventVisual> = {
  file_read: { Icon: FileSearch, tone: "text-zinc-500", label: "Read" },
  file_edit: { Icon: Pencil, tone: "text-zinc-500", label: "Edit" },
  file_write: { Icon: FilePlus2, tone: "text-zinc-500", label: "Write" },
  file_delete: { Icon: XCircle, tone: "text-red-400/70", label: "Delete" },
  file_move: { Icon: Wrench, tone: "text-zinc-500", label: "Move" },
  file_access: { Icon: FileSearch, tone: "text-zinc-500", label: "File" },
  shell_command: { Icon: Terminal, tone: "text-zinc-500", label: "Run" },
  web_search: { Icon: Search, tone: "text-zinc-500", label: "Web search" },
  web_fetch: { Icon: Search, tone: "text-zinc-500", label: "Web fetch" },
  search_results: { Icon: Search, tone: "text-zinc-500", label: "Search" },
  git_status: { Icon: GitBranch, tone: "text-zinc-500", label: "Git status" },
  git_diff: { Icon: GitBranch, tone: "text-zinc-500", label: "Git diff" },
  git_show: { Icon: GitCommit, tone: "text-zinc-500", label: "Git show" },
  git_log: { Icon: GitCommit, tone: "text-zinc-500", label: "Git log" },
  git_commit: { Icon: GitCommit, tone: "text-zinc-500", label: "Git commit" },
  git_remote: { Icon: GitBranch, tone: "text-zinc-500", label: "Git remote" },
  git_command: { Icon: GitBranch, tone: "text-zinc-500", label: "Git command" },
};

const GIT_EVENT_TYPES = new Set<ToolEventType>([
  "git_status", "git_diff", "git_show", "git_log", "git_commit", "git_remote", "git_command",
]);

/** Icon + tone + short label for a persisted trace row. Approval rows get the
 *  shield/check/x family; agent-progress rows map by phase. */
// Keep the timeline quiet and monochrome (Codex/Claude style): icons carry the
// category, but the palette stays muted zinc so steps read as ambient progress
// rather than a loud status board. Color is reserved for genuine failures (and a
// soft amber for a still-pending approval).
function eventMeta(e: TraceEvent): EventVisual {
  if (e.kind === "approval") {
    const ak = e.approval_kind ?? "";
    if (ak === "resolved") {
      const ok = (e.decision ?? "").startsWith("allow");
      return ok
        ? { Icon: Check, tone: "text-zinc-500", label: "Approved" }
        : { Icon: X, tone: "text-red-400/70", label: "Denied" };
    }
    if (ak === "expired" || ak === "rejected") {
      return { Icon: X, tone: "text-zinc-600", label: ak === "expired" ? "Expired" : "Rejected" };
    }
    if (ak === "auto_allowed") {
      return { Icon: Check, tone: "text-zinc-500", label: "Auto-allowed" };
    }
    return { Icon: ShieldCheck, tone: "text-amber-400/70", label: "Approval" };
  }
  const presentation = toolPresentationFromTrace(e);
  if (presentation) return TOOL_EVENT_META[presentation.event_type];
  switch (e.phase) {
    case "tool_call":
    case "tool_call_update":
      return { Icon: Wrench, tone: "text-zinc-500", label: "Tool" };
    case "plan":
      return { Icon: ListTodo, tone: "text-zinc-500", label: "Plan" };
    case "prompt_finished":
      return { Icon: Check, tone: "text-zinc-500", label: "Done" };
    case "prompt_started":
      return { Icon: Zap, tone: "text-zinc-500", label: "Start" };
    case "prompt_failed":
    case "terminal_ack_failed":
      return { Icon: XCircle, tone: "text-red-400/70", label: "Failed" };
    default:
      return { Icon: Clock, tone: "text-zinc-600", label: e.phase || "Event" };
  }
}

// Map the ACP tool-call status vocabulary (pending/in_progress/completed/failed)
// to human labels — mirrors PlanBoardPanel's group labels — with a humanize
// fallback so an unknown token never renders as raw snake_case.
const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
};

function statusLabel(status: string): string {
  return (
    STATUS_LABELS[status] ??
    status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

type JsonRecord = Record<string, unknown>;

function GitStatusInspector({ presentation }: { presentation: ToolPresentation }) {
  const result = parseGitStatusResult(presentation);
  if (!result) return null;
  const countItems = [
    ["staged", result.counts.staged],
    ["unstaged", result.counts.unstaged],
    ["untracked", result.counts.untracked],
    ["conflicted", result.counts.conflicted],
  ].filter((item): item is [string, number] => typeof item[1] === "number" && item[1] > 0);

  return (
    <div className="rounded-sm bg-zinc-950/45 px-3 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
        <span className="font-mono text-compact text-zinc-400">{result.branch ?? "Working tree"}</span>
        {result.clean === true && <span className="text-emerald-400/80">Clean</span>}
        {countItems.length > 0 && (
          <span className="text-minimal text-zinc-400">
            {countItems.map(([name, count]) => `${count} ${name}`).join(" · ")}
          </span>
        )}
      </div>
      {result.files.length > 0 && (
        <div className="mt-3 max-h-64 space-y-0.5 overflow-auto">
          {result.files.map((file, index) => {
            const marker = file.state === "untracked" ? "A" : file.index.trim() || file.worktree.trim() || "M";
            return (
              <div key={`${file.path}-${index}`} className="flex min-w-0 items-center gap-3 rounded-sm px-1 py-2 hover:bg-zinc-900/60">
                <span className={cn(
                  "w-4 shrink-0 font-mono text-minimal",
                  file.state === "conflicted" ? "text-red-300/80" : file.state === "untracked" ? "text-emerald-400/80" : "text-zinc-500",
                )}>{marker}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-compact text-zinc-300" title={file.path}>{file.path}</span>
              </div>
            );
          })}
        </div>
      )}
      {result.truncated && <div className="mt-2 text-zinc-400">More files omitted.</div>}
      {presentation.compound && (
        <div className="mt-2 text-minimal text-zinc-400">
          Status summary extracted from compound shell output.
        </div>
      )}
    </div>
  );
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

const DETAIL_PREVIEW_LIMIT = 12_000;

function formatJson(value: unknown, limit = DETAIL_PREVIEW_LIMIT): string {
  const formatted = JSON.stringify(value, null, 2) ?? String(value);
  return formatted.length > limit
    ? `${formatted.slice(0, limit)}\n… preview truncated (${formatted.length - limit} more characters)`
    : formatted;
}

function DetailValue({ value }: { value: unknown }) {
  const rendered = typeof value === "string"
    ? value.length > DETAIL_PREVIEW_LIMIT
      ? `${value.slice(0, DETAIL_PREVIEW_LIMIT)}\n… preview truncated (${value.length - DETAIL_PREVIEW_LIMIT} more characters)`
      : value
    : formatJson(value);
  return (
    <pre className="whitespace-pre-wrap break-words font-mono">
      {rendered}
    </pre>
  );
}

function stringField(record: JsonRecord | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function RawEventData({ metadata, data }: { metadata: JsonRecord; data: JsonRecord | null }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-zinc-400 hover:text-zinc-200">Raw event data</summary>
      {open && (
        <div className="mt-2 max-h-64 overflow-auto">
          <DetailValue value={{ ...metadata, ...(data ? { data } : {}) }} />
        </div>
      )}
    </details>
  );
}

function DiffDelta({ stats }: { stats: { additions: number; deletions: number } }) {
  return (
    <span className="shrink-0 font-mono text-minimal tabular-nums">
      <span className="text-emerald-400/90">+{stats.additions}</span>
      {" "}
      <span className="text-red-400/80">−{stats.deletions}</span>
    </span>
  );
}

function FileEditInspector({ diffs }: { diffs: FileDiff[] }) {
  const [selectedPath, setSelectedPath] = useState(diffs[0]?.path ?? "");
  const selected = diffs.find((diff) => diff.path === selectedPath) ?? diffs[0];
  const total = aggregateDiffStats(diffs);
  if (!selected) return null;
  const selectedStats = diffStats(selected);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-0.5">
        <span className="min-w-0 truncate font-mono text-compact text-zinc-300" title={selected.path}>
          {pathBasename(selected.path)}
        </span>
        <DiffDelta stats={diffs.length === 1 ? selectedStats : total} />
      </div>
      <div className="grid min-h-64 grid-cols-[minmax(9rem,12rem)_minmax(0,1fr)] gap-3">
        <div className="min-w-0 space-y-1 py-1">
          {diffs.map((diff) => {
            const stats = diffStats(diff);
            const active = diff.path === selected.path;
            return (
              <UiButton controlWidth="fill" variant="plain"
                key={diff.path}
                type="button"
                onClick={() => setSelectedPath(diff.path)}
                controlSize="regular" className={cn(
 "flex items-center gap-2 rounded-sm text-left transition-colors hover:bg-zinc-800",
 active ? "bg-indigo-600/15 text-indigo-200": "text-zinc-400 hover:text-zinc-200",
 )}
                title={diff.path}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-compact">
                  {pathBasename(diff.path)}
                </span>
                <DiffDelta stats={stats} />
              </UiButton>
            );
          })}
        </div>
        <DiffView diff={fileDiffPreview(selected)} className="max-h-80 rounded-sm bg-zinc-950" />
      </div>
    </div>
  );
}

function FileEditEmptyState({ path }: { path: string | null }) {
  return (
    <div className="rounded-sm bg-zinc-950/45 px-3 py-3">
      <div className="text-compact text-zinc-300">No file changes</div>
      {path && (
        <div className="mt-1 truncate font-mono text-compact text-zinc-400" title={path}>
          {path}
        </div>
      )}
      <div className="mt-1 text-minimal text-zinc-400">
        The edit reported identical before/after content.
      </div>
    </div>
  );
}

function eventPreview(event: TraceEvent): string | null {
  const presentation = toolPresentationFromTrace(event);
  const data = asRecord(event.data);
  const diffs = fileDiffsFromData(data);
  if (presentation?.event_type === "file_edit") {
    if (diffs.length > 0) {
      const stats = aggregateDiffStats(diffs);
      const label = diffs.length === 1
        ? pathBasename(diffs[0].path)
        : `${diffs.length} files`;
      return `${label} · ${formatDiffDelta(stats)}`;
    }
    const path = presentation.path ?? presentation.target;
    return path ? `${pathBasename(path)} · no changes` : "No file changes";
  }
  const gitStatus = parseGitStatusResult(presentation);
  if (gitStatus) {
    if (gitStatus.clean) {
      return gitStatus.branch ? `${gitStatus.branch} · clean` : "Clean";
    }
    if (gitStatus.files.length > 0) {
      return `${gitStatus.files.length} file${gitStatus.files.length === 1 ? "" : "s"} changed`;
    }
  }
  if (presentation) {
    return presentation.target ?? presentation.path ?? presentation.query ?? presentation.command ?? null;
  }
  const input = asRecord(data?.input);
  const command = stringField(input, "command") ?? stringField(data, "command");
  const filePath = stringField(input, "path", "filePath", "file_path");
  if (diffs.length) return `${diffs.length} file${diffs.length === 1 ? "" : "s"} changed`;
  if (command) return command;
  if (filePath) return filePath;
  if (event.kind === "approval" && event.decision) return event.decision;
  if (event.message && event.message !== event.title) return event.message;
  if (event.status) return statusLabel(event.status);
  return null;
}

/** The inspector deliberately omits the single-line row's preview. It exposes
 * only the additional context needed to inspect the operation. */
function TraceEventInspector({ event }: { event: TraceEvent }) {
  const data = asRecord(event.data);
  const input = asRecord(data?.input);
  const cwd = stringField(input, "cwd", "working_directory");
  const filePath = stringField(input, "path", "filePath", "file_path");
  const diffs = fileDiffsFromData(data);
  const planEntries = Array.isArray(data?.entries) ? data.entries : null;
  const output = data?.output;
  const presentation = toolPresentationFromTrace(event);
  const outputText = typeof output === "string"
    ? output
    : typeof asRecord(output)?.text === "string"
      ? asRecord(output)?.text as string
      : null;
  const outputDiff = presentation && ["file_edit", "git_diff", "git_show"].includes(presentation.event_type)
    && outputText?.includes("diff --git ")
    ? outputText
    : null;
  const hasGitStatus = Boolean(parseGitStatusResult(presentation));
  const isFileEdit = presentation?.event_type === "file_edit";
  const showFileEditEmpty = isFileEdit && diffs.length === 0 && !outputDiff;
  const metadata = {
    phase: event.phase,
    kind: event.kind,
    event_id: event.event_id ?? event.id,
    ...(event.tool_call_id ? { tool_call_id: event.tool_call_id } : {}),
    ...(event.request_id ? { request_id: event.request_id } : {}),
    created_at: event.created_at,
  };

  return (
    <div className="space-y-3 p-3 text-compact text-zinc-400">
      {presentation && (
        <div className="rounded-sm bg-zinc-950/45 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-200">
              {TOOL_EVENT_META[presentation.event_type].label}
            </span>
            {presentation.risk && (
              <span className="text-minimal text-zinc-500">
                {presentation.risk.replace(/_/g, " ")}
              </span>
            )}
            {presentation.compound && (
              <span className="text-minimal text-amber-300/80">
                compound shell command
              </span>
            )}
          </div>
          {presentation.command && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-zinc-300">{presentation.command}</pre>
          )}
          {!presentation.command && presentation.target && (
            <div className="mt-2 break-all font-mono text-zinc-300">{presentation.target}</div>
          )}
        </div>
      )}
      {diffs.length > 0 && <FileEditInspector diffs={diffs} />}
      {showFileEditEmpty && (
        <FileEditEmptyState path={presentation?.path ?? presentation?.target ?? filePath} />
      )}
      {outputDiff && <DiffView diff={outputDiff} className="max-h-80 rounded-sm bg-zinc-950" />}
      {presentation && hasGitStatus && <GitStatusInspector presentation={presentation} />}
      {planEntries && (
        <div className="space-y-1.5">
          <div className="text-minimal font-medium uppercase tracking-wide text-zinc-400">Plan</div>
          {planEntries.length > 0 ? (
            <ol className="space-y-1 pl-4 list-decimal">
              {planEntries.map((entry, index) => {
                const item = asRecord(entry);
                const content =
                  typeof item?.content === "string"
                    ? item.content
                    : formatJson(entry);
                const status = typeof item?.status === "string" ? item.status : null;
                return (
                  <li key={`${index}-${content}`} className="break-words">
                    <span className="text-zinc-300">{content}</span>
                    {status && (
                      <span className="ml-1.5 text-zinc-500">
                        {statusLabel(status)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div>No plan entries reported.</div>
          )}
        </div>
      )}

      {cwd && (
        <div>
          <div className="text-minimal font-medium uppercase tracking-wide text-zinc-400">Working directory</div>
          <div className="mt-1 font-mono text-zinc-200">{cwd}</div>
        </div>
      )}
      {!diffs.length && !showFileEditEmpty && filePath && (
        <div>
          <div className="text-minimal font-medium uppercase tracking-wide text-zinc-400">File</div>
          <div className="mt-1 font-mono text-zinc-200">{filePath}</div>
        </div>
      )}
      {output != null && !outputDiff && !hasGitStatus && !showFileEditEmpty && (
        <div>
          <div className="mb-1 text-minimal font-medium uppercase tracking-wide text-zinc-400">Output</div>
          <div className="max-h-56 overflow-auto rounded-sm bg-zinc-950 px-2.5 py-2 text-zinc-300"><DetailValue value={output} /></div>
        </div>
      )}
      <RawEventData metadata={metadata} data={data} />
    </div>
  );
}


/** Visual approval detail built from a trace event when the permission message
 *  is gone — never fall back to raw JSON for kind=approval. */
function ApprovalEventCard({ event }: { event: TraceEvent }) {
  const data = asRecord(event.data);
  const tool = asRecord(data?.tool);
  const command =
    stringField(tool, "command", "summary")
    ?? (typeof event.message === "string" && event.message.trim() ? event.message : null);
  const cwd = stringField(tool, "cwd", "working_directory");
  const title =
    (typeof event.title === "string" && event.title.trim() && event.title !== "ACP permission request"
      ? event.title
      : null)
    ?? "Approval needed";
  const pending =
    event.status === "pending"
    || event.approval_kind === "requested"
    || (!event.decision && event.approval_kind !== "resolved" && event.approval_kind !== "expired");
  const decision = event.decision ?? null;
  const ok = typeof decision === "string" && decision.startsWith("allow");
  const denied = typeof decision === "string" && decision.startsWith("reject");
  const expired = event.approval_kind === "expired" || event.status === "expired";

  return (
    <div className="overflow-hidden rounded-sm bg-zinc-950/45">
      <header className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-zinc-800">
        <div className="min-w-0">
          <p className="text-regular font-medium text-zinc-200">{title}</p>
          <p className="mt-0.5 text-compact text-zinc-400">
            {pending
              ? "Waiting for a decision."
              : expired
                ? "This request expired."
                : ok
                  ? "Approved."
                  : denied
                    ? "Denied."
                    : statusLabel(event.status ?? event.approval_kind ?? "done")}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 text-compact",
            pending ? "text-amber-400/90" : ok ? "text-zinc-400" : denied || expired ? "text-red-400/70" : "text-zinc-400",
          )}
        >
          {pending ? "Needs approval" : expired ? "Expired" : ok ? "Approved" : denied ? "Denied" : statusLabel(event.status ?? "Done")}
        </span>
      </header>
      {command && (
        <div className="border-b border-zinc-800 bg-zinc-950/40 px-3 py-2.5">
          <p className="mb-1.5 text-minimal uppercase tracking-wide text-zinc-400">Command</p>
          <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-black/40 px-2 py-1.5 font-mono text-compact text-zinc-300">
            {command}
          </pre>
          {cwd && (
            <p className="mt-2 truncate font-mono text-compact text-zinc-500" title={cwd}>
              {cwd}
            </p>
          )}
        </div>
      )}
      {!pending && decision && (
        <div className="px-3 py-2.5 text-compact text-zinc-400">
          Decision: <span className="font-mono text-zinc-300">{decision}</span>
        </div>
      )}
    </div>
  );
}

function TraceItem({
  event,
  active,
  onToggle,
  pendingApproval,
  channelId,
  currentUserId,
  onApprovalResolved,
}: {
  event: TraceEvent;
  active: boolean;
  onToggle: () => void;
  /** Permission message for this approval row (pending or resolved). */
  pendingApproval?: Message;
  channelId?: string;
  currentUserId?: string;
  onApprovalResolved?: () => void;
}) {
  const { Icon, tone, label } = eventMeta(event);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingData = pendingApproval
    ? (pendingApproval.content_data as PermissionContentData | null | undefined)
    : null;
  const preview = eventPreview(event)
    ?? pendingData?.tool?.command
    ?? pendingData?.body
    ?? null;
  const presentation = toolPresentationFromTrace(event);
  const displayTitle = presentation
    ? label
    : event.title || (pendingApproval ? "Approval" : label);
  const needsAction = Boolean(
    pendingApproval &&
      !(pendingApproval.content_data as PermissionContentData | null | undefined)?.resolved,
  );
  const statusTone = needsAction
    ? "text-amber-400/90"
    : event.status === "failed"
      ? "text-red-400/80"
      : presentation && GIT_EVENT_TYPES.has(presentation.event_type) && event.status === "completed"
        ? "text-emerald-400/80"
        : "text-zinc-400";
  const statusText = needsAction
    ? "Needs approval"
    : event.status
      ? statusLabel(event.status)
      : null;

  // Esc closes the floating inspector only (pending approvals stay inline).
  useEffect(() => {
    if (!active || needsAction) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onToggle();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, needsAction, onToggle]);

  // Pending approvals expand inline under the row with action buttons — no click needed.
  if (needsAction && pendingApproval) {
    return (
      <div className="min-w-0 space-y-1.5">
        <div
          className={cn(
            "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left",
            "bg-amber-500/5",
          )}
        >
          <Icon className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
          <span className="min-w-0 max-w-[45%] shrink truncate text-compact font-medium text-zinc-200">
            {displayTitle}
          </span>
          {preview && (
            <span className="min-w-0 flex-1 truncate font-mono text-minimal text-zinc-400" title={preview}>
              {preview}
            </span>
          )}
          <span className={cn("shrink-0 text-minimal", statusTone)}>{statusText}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-amber-400/70" />
        </div>
        <PermissionCard
          message={pendingApproval}
          channelId={channelId}
          currentUserId={currentUserId}
          onResolved={onApprovalResolved}
          embedded
        />
      </div>
    );
  }

  return (
    <div className="relative min-w-0">
      <UiButton controlWidth="fill" variant="plain"
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-expanded={active}
        aria-label={`${active ? "Hide" : "Show"} details for ${displayTitle}`}
        controlSize="compact" className={cn(
 "flex items-center gap-2 rounded-sm text-left transition-colors hover:bg-zinc-900/70",
 active && "bg-zinc-900/70",
 )}
      >
        <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />
        <span className="min-w-0 max-w-[45%] shrink truncate text-compact font-medium text-zinc-200">
          {displayTitle}
        </span>
        {preview && (
          <span className="min-w-0 flex-1 truncate font-mono text-minimal text-zinc-400" title={preview}>
            {preview}
          </span>
        )}
        {statusText && (
          <span className={cn("shrink-0 text-minimal", statusTone)}>
            {statusText}
          </span>
        )}
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform",
            active && "rotate-90 text-zinc-300",
          )}
        />
      </UiButton>
      {active &&
        createPortal(
          <FloatingPanel
            title={event.kind === "approval" ? "Approval needed" : displayTitle}
            icon={event.kind === "approval" ? ShieldCheck : Icon}
            onClose={onToggle}
            storageKey={
              event.kind === "approval"
                ? "cheers.float.trace-approval"
                : "cheers.float.trace-inspector"
            }
            className={
              event.kind === "approval"
                ? "w-[min(28rem,94vw)] h-auto max-h-[min(36rem,calc(100dvh-10rem))]"
                : "w-[min(42rem,94vw)] h-[min(32rem,calc(100dvh-10rem))]"
            }
            // Portaled to body: must ignore LaneBoundsContext, else absolute
            // coords bind to the wrong box and drag/placement break.
            viewport
            anchorRef={triggerRef}
            reanchorOnOpen
            bodyClassName="!p-0"
          >
            <div className="p-3">
              {pendingApproval ? (
                <PermissionCard
                  message={pendingApproval}
                  channelId={channelId}
                  currentUserId={currentUserId}
                  onResolved={onApprovalResolved}
                />
              ) : event.kind === "approval" ? (
                <ApprovalEventCard event={event} />
              ) : (
                <TraceEventInspector event={event} />
              )}
            </div>
          </FloatingPanel>,
          document.body,
        )}
    </div>
  );
}

/** Build a timeline row for a pending permission that has not landed in message_traces yet. */
function syntheticApprovalEvent(message: Message, anchorMsgId: string): TraceEvent {
  const data = (message.content_data ?? {}) as PermissionContentData;
  return {
    v: 1,
    id: `pending:${message.msg_id}`,
    msg_id: anchorMsgId,
    channel_id: null,
    trace_seq: null,
    kind: "approval",
    phase: "approval",
    status: "pending",
    title: data.title && data.title !== "ACP permission request" ? data.title : "Approval needed",
    message: data.body ?? data.tool?.command ?? null,
    data: { tool: data.tool ?? null },
    request_id: data.request_id ?? null,
    tool_call_id: data.tool?.tool_call_id ?? null,
    operation_kind: "approval",
    operation_id: data.request_id ?? message.msg_id,
    is_terminal: false,
    approval_kind: "requested",
    decision: null,
    option_id: null,
    created_at: message.created_at ?? new Date().toISOString(),
  };
}

/**
 * Collapsible "agent steps" panel for a bot turn. Lazily fetches the durable
 * trace timeline (docs/arch/TRACE_PERSISTENCE.md) on first expand and renders
 * each step — including approval events interleaved inline. Pending approvals
 * stay as normal timeline rows; their detail is the interactive PermissionCard,
 * auto-opened until the user decides.
 * Self-hides when a turn has no recorded steps and no pending approvals.
 */
export function BotTracePanel({
  channelId,
  msgId,
  liveEvents = [],
  pendingApprovals = [],
  currentUserId,
  streaming = false,
  focusRequestId = null,
  expanded: controlledExpanded,
  onExpandedChange,
  showToggle = true,
}: Props) {
  const [internalExpanded, setInternalExpanded] = useState(
    pendingApprovals.some(
      (message) =>
        !(message.content_data as PermissionContentData | null | undefined)?.resolved,
    ) || !!focusRequestId,
  );
  const expanded = controlledExpanded ?? internalExpanded;
  const updateExpanded = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(expanded) : next;
    if (controlledExpanded === undefined) setInternalExpanded(value);
    onExpandedChange?.(value);
  };
  const [showAll, setShowAll] = useState(false);
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [events, setEvents] = useState<TraceEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayedEvents = useMemo(
    () => coalesceTraceEvents(events ?? [], liveEvents),
    [events, liveEvents],
  );

  const approvalByRequestId = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of pendingApprovals) {
      const requestId = (message.content_data as PermissionContentData | null | undefined)
        ?.request_id;
      if (requestId) map.set(requestId, message);
    }
    return map;
  }, [pendingApprovals]);

  const actionableApprovals = useMemo(
    () =>
      pendingApprovals.filter(
        (message) =>
          !(message.content_data as PermissionContentData | null | undefined)?.resolved,
      ),
    [pendingApprovals],
  );
  const hasActionable = actionableApprovals.length > 0;

  const renderedApprovalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of displayedEvents) {
      if (event.kind !== "approval" || !event.request_id) continue;
      const approval = approvalByRequestId.get(event.request_id);
      if (approval) ids.add(approval.msg_id);
    }
    return ids;
  }, [displayedEvents, approvalByRequestId]);

  const orphanPending = useMemo(
    () =>
      actionableApprovals.filter((message) => !renderedApprovalIds.has(message.msg_id)),
    [actionableApprovals, renderedApprovalIds],
  );

  const timeline = useMemo(() => {
    if (orphanPending.length === 0) return displayedEvents;
    return [
      ...displayedEvents,
      ...orphanPending.map((message) => syntheticApprovalEvent(message, msgId)),
    ];
  }, [displayedEvents, orphanPending, msgId]);

  // While the turn is running, only show the latest step (plus any actionable
  // approval that isn't that step). Completed turns / explicit "Show all" keep
  // the full timeline for auditability.
  const visibleTimeline = useMemo(() => {
    if (!streaming || showAll || timeline.length <= 1) return timeline;
    const latest = timeline[timeline.length - 1]!;
    const pendingExtras = timeline.filter((e) => {
      if (e === latest || e.kind !== "approval" || !e.request_id) return false;
      const approval = approvalByRequestId.get(e.request_id);
      if (!approval) return false;
      return !(approval.content_data as PermissionContentData | null | undefined)
        ?.resolved;
    });
    return [...pendingExtras, latest];
  }, [streaming, showAll, timeline, approvalByRequestId]);

  // Keep Agent steps open while something still needs a decision.
  useEffect(() => {
    if (hasActionable) updateExpanded(true);
    // The controlled parent owns identity; only the actionable state should
    // trigger this transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActionable]);

  // Deep-link from ViewBoard: open panel and focus the matching approval row.
  useEffect(() => {
    if (!focusRequestId) return;
    updateExpanded(true);
    setShowAll(true);
    const match = timeline.find((e) => e.request_id === focusRequestId);
    if (match) setActiveEventId(match.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequestId, timeline]);

  // After the turn finishes, drop the "latest only" filter so history is full by default.
  useEffect(() => {
    if (!streaming) setShowAll(false);
  }, [streaming]);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMessageTrace(channelId, msgId);
      setEvents(res.events ?? []);
    } catch (e) {
      // Leave events === null so the next expand retries.
      setError(e instanceof Error ? e.message : "Failed to load trace");
    } finally {
      setLoading(false);
    }
  }

  // Fetch on open (user toggle or auto-open for a pending approval).
  useEffect(() => {
    if (!expanded || events !== null || loading) return;
    void load();
    // Intentionally keyed on expand/cache only — load() closes over the latest ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, events, loading, channelId, msgId]);

  // Once we've loaded and found nothing (and nothing pending), drop the toggle.
  if (
    events !== null &&
    timeline.length === 0 &&
    !hasActionable &&
    !expanded
  ) {
    return null;
  }

  const approvalCount = timeline.filter((e) => e.kind === "approval").length;
  const pendingCount = actionableApprovals.length;
  const hasRows = visibleTimeline.length > 0;
  const latestOnly = streaming && !showAll && timeline.length > 1;

  return (
    <div className={cn(hasActionable ? "max-w-lg" : "max-w-md")}>
      {showToggle && (
        <UiButton variant="plain"
          type="button"
          onClick={() => updateExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? "Hide agent steps" : "Show agent steps"}
          className="flex items-center gap-1.5 text-compact text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <span>
            Agent steps
            {latestOnly
              ? " · latest"
              : events !== null || timeline.length > 0 || hasActionable
                ? ` · ${timeline.length}`
                : ""}
          </span>
          {pendingCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-amber-400/80">
              <ShieldCheck className="w-3.5 h-3.5" />
              {pendingCount} pending
            </span>
          ) : approvalCount > 0 ? (
            <span className="inline-flex items-center gap-0.5 text-zinc-400">
              <ShieldCheck className="w-3.5 h-3.5" />
              {approvalCount}
            </span>
          ) : null}
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        </UiButton>
      )}

      {!showToggle && expanded && loading && !hasRows && (
        <div className="flex items-center gap-1.5 text-compact text-zinc-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading steps…
        </div>
      )}

      {expanded && hasRows && (
        <div className="mt-2 flex flex-col gap-1">
          {visibleTimeline.map((event) => {
            const approval =
              event.kind === "approval" && event.request_id
                ? approvalByRequestId.get(event.request_id)
                : undefined;
            return (
              <TraceItem
                key={event.id}
                event={event}
                active={activeEventId === event.id}
                pendingApproval={approval}
                channelId={channelId}
                currentUserId={currentUserId}
                onToggle={() =>
                  setActiveEventId((current) =>
                    current === event.id ? null : event.id,
                  )
                }
                onApprovalResolved={() => setActiveEventId(null)}
              />
            );
          })}
          {latestOnly && (
            <UiButton variant="plain"
              type="button"
              onClick={() => setShowAll(true)}
              className="self-start text-compact text-zinc-500 hover:text-zinc-300 transition-colors mt-0.5"
            >
              Show all {timeline.length} steps
            </UiButton>
          )}
          {streaming && showAll && timeline.length > 1 && (
            <UiButton variant="plain"
              type="button"
              onClick={() => setShowAll(false)}
              className="self-start text-compact text-zinc-500 hover:text-zinc-300 transition-colors mt-0.5"
            >
              Show latest only
            </UiButton>
          )}
        </div>
      )}

      {expanded && events && !hasRows && !loading && !error && (
        <div className="mt-1 px-2.5 text-compact text-zinc-400">
          No steps recorded.
        </div>
      )}

      {expanded && error && !loading && (
        <div className="mt-1 px-2.5 flex items-center gap-2 text-compact text-red-400">
          <span>Failed to load steps.</span>
          <UiButton variant="plain"
            type="button"
            onClick={() => void load()}
            className="text-zinc-400 hover:text-zinc-200 underline underline-offset-2"
          >
            Retry
          </UiButton>
        </div>
      )}
    </div>
  );
}
