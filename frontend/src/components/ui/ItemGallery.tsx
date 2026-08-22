import { Activity, AlertCircle, AlertTriangle, CircleCheck, ClipboardList, DollarSign, Hash, Info, LayoutDashboard, Lock, MessageSquarePlus, Plus, User, Users, X } from "lucide-react";
import { useState } from "react";
import {
  EditorialIcon,
  editorialIconNames,
  type EditorialIconName,
} from "@/components/ui/editorial-icons";
import {
  DiffLineItem,
  EntityItem,
  FileTreeItem,
  ItemChip,
  ItemList,
  ItemRow,
  ItemSection,
  NavigationItem,
  OperationsItem,
  WorkbenchItem,
} from "@/components/ui/item";
import type { PresentationLevel } from "@/components/ui/presentation";
import { cn } from "@/lib/cn";
import { ControlSizeProvider, type ControlSize } from "@/components/ui/control-size";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
import { AdaptiveControlGroup } from "@/components/ui/adaptive-control-group";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { InputWithLeadingIcon } from "@/components/ui/input-with-leading-icon";
import { SearchInput } from "@/components/ui/search-input";
import { MenuOption } from "@/components/ui/menu-option";
import { TabOption } from "@/components/ui/tab-option";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { ChoiceGroup } from "@/components/ui/choice-button";
import { ThemeSelector } from "@/components/ui/theme-selector";
import { CollectionManagerDemo } from "@/components/ui/CollectionManagerDemo";
import { InlineReference } from "@/components/ui/inline-reference";
import { Banner } from "@/components/ui/banner";
import { ErrorState } from "@/components/ui/error-state";
import { MetricCard } from "@/components/ui/metric-card";
import { SettingsCard } from "@/components/ui/settings-card";
import { BotTracePanel } from "@/features/chat/BotTracePanel";
import type { TraceEvent } from "@/types";

const levels: PresentationLevel[] = ["max", "medium", "minimal"];
const controlSizes: ControlSize[] = ["comfortable", "regular", "compact"];

const adaptivePreviewItems = [
  { id: "plan", label: "Plan", icon: ClipboardList },
  { id: "cost", label: "Cost", icon: DollarSign },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "roster", label: "Roster", icon: Users },
  { id: "boards", label: "Boards", icon: LayoutDashboard },
];

function AdaptiveGroupPreview({ availableWidth }: { availableWidth: number }) {
  const [selected, setSelected] = useState("plan");
  return (
    <div style={{ width: availableWidth + 16 }} className="max-w-full min-w-0 bg-zinc-900/50 p-2">
      <p className="mb-2 text-section-label">{availableWidth}px local slot</p>
      <div style={{ width: `min(100%, ${availableWidth}px)` }} className="rounded-concentric bg-zinc-950/80 p-1 shadow-lg ring-1 ring-white/10">
        <AdaptiveControlGroup
          kind="navigation"
          ariaLabel={`Adaptive preview ${availableWidth}`}
          availableWidth={availableWidth}
          items={adaptivePreviewItems.map((item) => ({
            ...item,
            selected: selected === item.id,
            onSelect: () => setSelected(item.id),
          }))}
        />
      </div>
    </div>
  );
}

const traceGalleryEvents: TraceEvent[] = [
  {
    v: 1, id: "gallery-read", event_id: "gallery-read", msg_id: "gallery-message", channel_id: "gallery-channel",
    trace_seq: 1, kind: "trace", phase: "tool_call", status: "completed", is_terminal: true,
    created_at: "2026-08-12T07:44:00Z",
    data: { presentation: { v: 2, event_type: "file_read", family: "file", operation: "read", confidence: "explicit", matched_by: "gallery", path: "server/Cargo.toml" } },
  },
  {
    v: 1, id: "gallery-shell", event_id: "gallery-shell", msg_id: "gallery-message", channel_id: "gallery-channel",
    trace_seq: 2, kind: "trace", phase: "tool_call", status: "in_progress", is_terminal: false,
    created_at: "2026-08-12T07:44:01Z",
    data: { presentation: { v: 2, event_type: "shell_command", family: "shell", operation: "run", confidence: "explicit", matched_by: "gallery", command: "npm run typecheck" } },
  },
];

const iconLabels: Record<EditorialIconName, string> = {
  correspondence: "Correspondence",
  reply: "Reply",
  thread: "Thread",
  section: "Section / channel",
  edition: "Edition / workspace",
  editorialDesk: "Editorial desk",
  excerpt: "Context excerpt",
  attachment: "Attachment",
  proof: "Proof / plan",
  approvalSeal: "Approval seal",
  dispatch: "Dispatch / notice",
  archive: "Archive",
  agentMark: "Agent mark",
  session: "Session",
  taskDocket: "Task docket",
  diffProof: "Diff proof",
};

/** Development/visual-test gallery. It is intentionally not exposed as a product route. */
export function ItemGallery() {
  return (
    <main className="h-full overflow-y-auto bg-zinc-950 px-4 py-3 text-content-primary sm:px-5">
      <header className="mb-3 border-y-4 border-double border-zinc-500 py-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-utility text-minimal font-medium uppercase tracking-overline text-content-muted">
              Cross-platform design desk
            </p>
            <h1 className="font-masthead text-comfortable font-semibold sm:text-comfortable">
              Cheers Item Register
            </h1>
          </div>
          <p className="hidden max-w-56 text-right font-utility text-minimal font-medium uppercase leading-4 tracking-section text-content-muted sm:block">
            One anatomy · Three densities
            <br />Web · iOS · Android
          </p>
        </div>
      </header>

      <section aria-label="Appearance preview" className="mb-4 border-y border-zinc-700 px-3 py-3">
        <div className="flex items-start justify-between gap-4 max-sm:flex-col">
          <div>
            <p className="font-utility text-compact font-semibold text-content-primary">Appearance preview</p>
            <p className="font-utility text-compact text-content-muted">Shared System / Light / Dark tokens</p>
          </div>
          <ThemeSelector className="w-full sm:w-96" showStatus={false} />
        </div>
      </section>

      <section aria-labelledby="adaptive-control-register" className="mb-4 border-y border-zinc-700 px-3 py-3">
        <h2 id="adaptive-control-register" className="font-display text-comfortable font-semibold tracking-display">
          Adaptive control groups
        </h2>
        <div className="mt-3 flex flex-wrap items-start gap-3">
          {([440, 330, 200, 136] as const).map((availableWidth) => (
            <AdaptiveGroupPreview key={availableWidth} availableWidth={availableWidth} />
          ))}
        </div>
      </section>

      <section aria-labelledby="type-register" className="mb-4 grid border-y border-zinc-700 md:grid-cols-2 md:divide-x md:divide-zinc-700 xl:grid-cols-4">
        <div className="px-3 py-3">
          <p className="text-section-label">
            Display · Opsz 60
          </p>
          <h2 id="type-register" className="mt-1 font-display text-comfortable font-semibold tracking-display">
            The Formal Edition · 正式版
          </h2>
          <p className="mt-1 text-caption">Introductions · Hero titles · Major headings</p>
        </div>
        <div className="border-t border-zinc-700 px-3 py-3 md:border-t-0">
          <p className="text-section-label">
            Reading · Opsz 14
          </p>
          <p className="mt-1 text-message">
            A sturdy classical rhythm keeps long messages calm. 稳健的宋体让长消息正式而易读。
          </p>
          <p className="mt-1 text-caption">Messages · Previews · Long-form copy</p>
        </div>
        <div className="border-t border-zinc-700 px-3 py-3 md:border-l-0 xl:border-l">
          <p className="text-section-label">
            Utility · Source Sans 3
          </p>
          <p className="mt-2 font-utility text-compact font-semibold uppercase tracking-overline text-warning-300">
            Channel name · 频道名称 · Warning · Trace active
          </p>
          <p className="mt-2 text-caption">Controls · Status · Trace labels</p>
        </div>
        <div className="border-t border-zinc-700 px-3 py-3 md:border-l xl:border-t-0">
          <p className="text-section-label">
            Code · System Mono
          </p>
          <code className="mt-2 block overflow-x-auto whitespace-nowrap font-code text-compact text-content-secondary">
            infisical run --env=dev -- cargo run
          </code>
          <p className="mt-2 text-caption">Commands · Paths · IDs · Diffs</p>
        </div>
      </section>

      <section aria-labelledby="inline-reference-register" className="mb-4 border-y border-zinc-700 py-3">
        <h2 id="inline-reference-register" className="font-display text-comfortable font-semibold tracking-display">
          Inline Workspace References
        </h2>
        <p className="mt-2 font-reading text-regular leading-6 text-content-secondary">
          Current project directory: <InlineReference reference="/workspace/Cheers" aria-label="Open /workspace/Cheers in the remote workspace" />;
          branch: <InlineReference reference="codex/fix-inline-workspace-links" aria-label="Open codex/fix-inline-workspace-links in the remote workspace" />;
          client: <InlineReference reference="frontend/src" aria-label="Open frontend/src in the remote workspace" />.
        </p>
        <p className="mt-1 font-utility text-compact text-content-muted">
          Preserve the referenced text; the Open action belongs to its accessible name, never the visible label.
        </p>
      </section>

      <section aria-labelledby="trace-disclosure-register" className="mb-4 border-y border-zinc-700 py-3">
        <h2 id="trace-disclosure-register" className="font-display text-comfortable font-semibold tracking-display">
          Trace Disclosure
        </h2>
        <div className="mt-2">
          <BotTracePanel
            channelId="gallery-channel"
            msgId="gallery-message"
            liveEvents={traceGalleryEvents}
            expanded
            showToggle={false}
          />
        </div>
        <p className="mt-1 font-utility text-compact text-content-muted">
          Tool name, operation summary, and critical status remain visible; disclosure state is not a replacement label.
        </p>
      </section>

      <section aria-labelledby="control-size-register" className="mb-4 border-y border-zinc-700 py-3">
        <div className="mb-2 flex items-baseline justify-between border-b border-zinc-600 pb-1">
          <h2 id="control-size-register" className="font-display text-comfortable font-semibold tracking-display">
            Control Height Register
          </h2>
          <span className="font-utility text-minimal font-medium uppercase tracking-overline text-content-muted">
            44 · 36 · 28 px
          </span>
        </div>
        <div className="grid gap-px bg-zinc-800 lg:grid-cols-3">
          {controlSizes.map((size) => (
            <ControlSizeProvider key={size} size={size}>
              <div className="space-y-2 bg-zinc-950 p-3">
                <p className="font-utility text-minimal font-semibold uppercase tracking-overline text-content-muted">
                  {size}
                </p>
                <EntityItem title="Aligned item" leading={<User className="h-4 w-4" />} />
                <div className="flex flex-wrap items-center gap-2">
                  <IconButton label={`${size} add`}><Plus className="h-4 w-4" /></IconButton>
                  <Button variant="secondary">Save</Button>
                  <Button content="iconText" variant="secondary"><Plus className="h-4 w-4" />Add item</Button>
                </div>
                <div className="flex items-center gap-2">
                  <Input aria-label={`${size} input`} placeholder="Input" />
                </div>
                <InputWithLeadingIcon
                  leading={<Hash />}
                  aria-label={`${size} channel name`}
                  placeholder="Channel name…"
                />
                <SearchInput
                  aria-label={`${size} search`}
                  placeholder="Search…"
                />
                <div role="tablist" className="flex items-center gap-1">
                  <TabOption label="Active" selected />
                  <TabOption label="Archive" selected={false} />
                </div>
                <ChoiceGroup
                  ariaLabel={`${size} visibility choice`}
                  value="public"
                  onChange={() => undefined}
                  options={[
                    { value: "public", label: "Public", leading: <Hash /> },
                    { value: "private", label: "Private", leading: <Lock /> },
                  ]}
                />
                <div role="menu">
                  <MenuOption label="Open correspondence" leading={<EditorialIcon name="correspondence" contentSize="regular" />} />
                </div>
                <CheckboxField label="Include resolved items" />
              </div>
            </ControlSizeProvider>
          ))}
        </div>
      </section>

      <section aria-labelledby="state-register" className="mb-4 border-y border-zinc-700 py-3">
        <h2 id="state-register" className="mb-2 px-1 font-utility text-compact font-semibold uppercase tracking-overline text-content-muted">State register</h2>
        <div className="grid gap-px bg-zinc-800 lg:grid-cols-2">
          <ItemList className="bg-zinc-950 px-2">
            <NavigationItem title="Selected destination" subtitle="Current channel" selected onClick={() => undefined} />
            <EntityItem title="Disabled identity" subtitle="Unavailable on this platform" disabled onClick={() => undefined} />
          </ItemList>
          <ItemList className="bg-zinc-950 px-2">
            <OperationsItem
              title="Composite approval"
              subtitle="Critical status remains visible"
              criticalStatus={<span className="text-minimal font-semibold text-danger-300">ERROR</span>}
              actions={<><Button variant="ghost" controlSize="compact">Inspect</Button><Button variant="danger" controlSize="compact">Reject</Button></>}
            />
            <OperationsItem
              title="Loading operation"
              subtitle="Actions retain the shared height"
              actions={<Button variant="secondary" controlSize="compact" loading>Loading</Button>}
            />
            <OperationsItem
              title="Shared selected control"
              subtitle="Selection styling belongs to the Button primitive"
              actions={<Button content="icon" selected aria-label="Selected panel"><Hash className="h-4 w-4" /></Button>}
            />
          </ItemList>
        </div>
      </section>

      <section aria-labelledby="semantic-surface-register" className="mb-4 border-y border-zinc-700 py-3">
        <h2 id="semantic-surface-register" className="mb-2 text-section-label">Semantic surfaces</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <SettingsCard title="Color theme" description="Shared settings anatomy keeps titles, descriptions, actions, and content aligned.">
            <ThemeSelector showStatus={false} />
          </SettingsCard>
          <div className="grid grid-cols-2 gap-2">
            <MetricCard label="Online" value={4} tone="success" />
            <MetricCard label="Waiting" value={2} tone="warning" />
          </div>
        </div>
      </section>

      <section aria-labelledby="feedback-severity-register" className="mb-4 border-y border-zinc-700 py-3">
        <h2 id="feedback-severity-register" className="mb-2 text-section-label">Feedback severity</h2>
        <div className="grid gap-2 lg:grid-cols-2">
          <Banner severity="info" icon={Info}>Informational state</Banner>
          <Banner severity="success" icon={CircleCheck}>Successful persistent state</Banner>
          <Banner severity="warning" icon={AlertTriangle}>Degraded state that needs attention</Banner>
          <Banner severity="error" icon={AlertCircle}>Persistent failure in an otherwise usable view</Banner>
        </div>
        <ErrorState
          className="mt-3 bg-zinc-900"
          title="The current view is unavailable"
          description="Large failures replace the unusable region and provide a recovery action."
          action={{ label: "Retry", onClick: () => undefined }}
        />
      </section>

      <div className="grid border-y border-zinc-700 lg:grid-cols-3 lg:divide-x lg:divide-zinc-700">
        {levels.map((level, index) => (
            <section
              key={level}
              aria-labelledby={`gallery-${level}`}
              className={cn(
                "space-y-1 py-3 lg:px-3",
                index > 0 && "border-t border-zinc-700 lg:border-t-0"
              )}
            >
              <div className="mb-2 flex items-baseline justify-between border-b border-zinc-600 pb-1">
                <h2
                  id={`gallery-${level}`}
                  className="font-display text-comfortable font-semibold capitalize tracking-display"
                >
                  {level}
                </h2>
                <span className="font-utility text-minimal font-medium uppercase tracking-overline text-content-muted">
                  Edition 0{index + 1}
                </span>
              </div>
              <ItemList presentationLevel={level} controlSize="regular">
              <EntityItem
                leading={<User className="h-5 w-5" />}
                title="Ada Lovelace"
                subtitle="Platform engineer"
                metadata="Online · Berlin"
                criticalStatus={<span className="h-2 w-2 rounded-full bg-emerald-500" />}
              />
              <NavigationItem
                leading={<EditorialIcon name="section" contentSize="regular" />}
                title="release"
                subtitle="3 unread messages"
                criticalStatus={
                  <span className="rounded-sm bg-indigo-600 px-2 text-minimal font-bold text-content-on-accent">
                    3
                  </span>
                }
                selected
              />
              <ItemRow
                kind="conversation"
                leading={<EditorialIcon name="agentMark" contentSize="large" />}
                title="Codex"
                subtitle="Completed the design-system migration"
                preview="Shared anatomy is now available on Web, iOS, and Android."
                status={<span className="font-utility text-minimal font-semibold text-accent-300">BOT</span>}
              />
              <ItemRow
                kind="feedback"
                leading={<AlertTriangle className="h-5 w-5 text-warning-400" />}
                title="Connection degraded"
                subtitle="Messages remain readable while reconnecting."
                criticalStatus={
                  <span className="font-utility text-minimal font-semibold text-warning-300">
                    RETRYING
                  </span>
                }
              />
              <OperationsItem
                leading={<EditorialIcon name="approvalSeal" contentSize="large" className="text-warning-300" />}
                title="Deploy production change"
                subtitle="Approval required"
                criticalStatus={<span className="h-1.5 w-1.5 rounded-full bg-red-400" />}
                actions={<Button variant="ghost" controlSize="compact" className="text-warning-200">Review</Button>}
              />
              <WorkbenchItem
                leading={<EditorialIcon name="proof" contentSize="large" />}
                title="Release plan"
                subtitle="4 completed · 1 active"
                status={<span className="text-minimal text-success-400">ACTIVE</span>}
              />
              </ItemList>
              <div className="flex flex-wrap gap-1 pt-1">
                <ItemChip
                  leading={<EditorialIcon name="excerpt" contentSize="small" />}
                  label="Context: release plan"
                />
                <ItemChip
                  label="Approval required"
                  criticalStatus={<span className="h-1.5 w-1.5 rounded-full bg-red-400" />}
                />
                <ItemChip
                  leading={<DollarSign className="h-4 w-4" />}
                  label="Cost"
                  presentationLevel="max"
                  controlSize="regular"
                  className="bg-zinc-800/60 text-regular text-content-secondary"
                  actions={
                    <IconButton label="Remove Cost" controlSize="compact">
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  }
                />
                <Button content="iconText" variant="plain" controlSize="regular" className="bg-zinc-800/60 text-content-primary">
                  <MessageSquarePlus className="h-4 w-4" />
                  Add context
                </Button>
              </div>
            </section>
        ))}
      </div>

      <section aria-labelledby="collection-manager-register" className="mt-4 border-y border-zinc-700 py-3">
        <div className="mb-3 flex flex-col gap-1 border-b border-zinc-600 pb-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-utility text-compact font-semibold uppercase tracking-overline text-content-muted">
              CRUD collection pattern
            </p>
            <h2 id="collection-manager-register" className="font-display text-comfortable font-semibold tracking-display">
              Search · Add · Edit · Delete
            </h2>
          </div>
          <p className="max-w-xl font-utility text-compact leading-5 text-content-muted sm:text-right">
            Browse is the resting state. Add inserts an editor first; edit replaces its row;
            delete replaces its row with confirmation. No detached form and no immediate destructive icon.
          </p>
        </div>
        <div className="mx-auto max-w-3xl">
          <CollectionManagerDemo />
        </div>
      </section>

      <section aria-labelledby="action-register" className="mt-4 border-y border-zinc-700 py-3">
        <div className="mb-3 border-b border-zinc-600 pb-2">
          <p className="font-utility text-compact font-semibold uppercase tracking-overline text-content-muted">Action + context contract</p>
          <h2 id="action-register" className="font-display text-comfortable font-semibold tracking-display">Common Action Register</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2">
            <p className="font-utility text-compact text-content-muted">Window chrome · icon</p>
            <div className="flex gap-2">
              <ActionButton action="back" context="windowChrome" accessibleLabel="Back to channel" />
              <ActionButton action="refresh" context="windowChrome" accessibleLabel="Refresh channel" />
              <ActionButton action="more" context="windowChrome" accessibleLabel="More channel actions" />
              <ActionButton action="close" context="windowChrome" accessibleLabel="Close panel" />
            </div>
          </div>
          <div className="space-y-2">
            <p className="font-utility text-compact text-content-muted">Inline edit · icon</p>
            <div className="flex gap-2">
              <ActionButton action="edit" context="inlineEdit" accessibleLabel="Edit channel name" />
              <ActionButton action="cancel" context="inlineEdit" accessibleLabel="Cancel editing channel name" />
              <ActionButton action="save" context="inlineEdit" accessibleLabel="Save channel name" />
              <ActionButton action="delete" context="inlineEdit" accessibleLabel="Delete channel name" />
            </div>
          </div>
          <div className="space-y-2">
            <p className="font-utility text-compact text-content-muted">Full form · explicit label</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton action="cancel" context="form" />
              <ActionButton action="save" context="form" accessibleLabel="Save settings" />
              <ActionButton action="delete" context="confirmation" accessibleLabel="Delete channel" />
            </div>
          </div>
          <div className="space-y-2">
            <p className="font-utility text-compact text-content-muted">Account security · fixed tones</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton action="update" context="security" accessibleLabel="Update password" />
              <ActionButton action="copy" context="security" accessibleLabel="Copy secret" />
              <ActionButton action="unlink" context="security" accessibleLabel="Unlink Google" />
              <ActionButton action="enable" context="security" accessibleLabel="Enable authenticator" disabled />
            </div>
          </div>
          <div className="space-y-2">
            <p className="font-utility text-compact text-content-muted">Dark settings · fixed tones</p>
            <div className="flex flex-wrap gap-2">
              <ActionButton action="save" context="settings" accessibleLabel="Save speech settings" />
              <ActionButton action="enable" context="settings" accessibleLabel="Turn on notifications" />
              <ActionButton action="retry" context="settings" />
              <ActionButton action="signOut" context="settings" accessibleLabel="Sign out" />
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="specialized-register" className="mt-4 grid border-y border-zinc-700 lg:grid-cols-2 lg:divide-x lg:divide-zinc-700">
        <ItemSection label="Specialized file tree" className="px-3 py-3">
          <FileTreeItem depth={0} expanded disclosure={<span aria-hidden>⌄</span>} leading={<EditorialIcon name="archive" contentSize="regular" />} title="frontend" />
          <FileTreeItem depth={1} selected leading={<EditorialIcon name="attachment" contentSize="regular" />} title="ItemGallery.tsx" />
        </ItemSection>
        <div className="border-t border-zinc-700 px-3 py-3 lg:border-t-0">
          <h2 id="specialized-register" className="mb-1 font-utility text-compact font-semibold uppercase tracking-overline text-content-muted">Specialized diff</h2>
          <ItemList className="overflow-x-auto bg-zinc-950">
            <DiffLineItem controlSize="compact" tone="remove" lineNumber="18" marker="−" content="border-radius: 12px;" />
            <DiffLineItem controlSize="regular" tone="add" lineNumber="18" marker="+" content="border-radius: 10px;" />
            <DiffLineItem controlSize="comfortable" lineNumber="19" marker=" " content="font-family: var(--font-utility);" />
          </ItemList>
        </div>
      </section>

      <section aria-labelledby="editorial-icon-register" className="mt-4 border-y border-zinc-700 py-3">
        <div className="mb-2 flex items-baseline justify-between border-b border-zinc-600 pb-1">
          <h2 id="editorial-icon-register" className="font-display text-comfortable font-semibold tracking-display">
            Editorial Icon Register
          </h2>
          <span className="font-utility text-minimal font-medium uppercase tracking-overline text-content-muted">
            24 grid · 1.75 stroke · issue 02
          </span>
        </div>
        <div className="grid grid-cols-2 border-l border-t border-zinc-700 sm:grid-cols-4 lg:grid-cols-8">
          {editorialIconNames.map((name, index) => (
            <figure
              key={name}
              className="m-0 min-h-24 border-b border-r border-zinc-700 px-2 py-3"
            >
              <div className="mb-3 flex items-start justify-between text-content-secondary">
                <EditorialIcon name={name} title={iconLabels[name]} contentSize="large" />
                <span className="font-utility text-minimal tabular-nums text-content-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <figcaption className="font-reading text-compact leading-4 text-content-muted">
                {iconLabels[name]}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </main>
  );
}
