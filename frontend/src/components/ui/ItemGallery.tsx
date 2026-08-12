import { AlertTriangle, DollarSign, MessageSquarePlus, Plus, User, X } from "lucide-react";
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
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { MenuOption } from "@/components/ui/menu-option";
import { TabOption } from "@/components/ui/tab-option";
import { CheckboxField } from "@/components/ui/checkbox-field";
import { CollectionManagerDemo } from "@/components/ui/CollectionManagerDemo";

const levels: PresentationLevel[] = ["max", "medium", "minimal"];
const controlSizes: ControlSize[] = ["comfortable", "regular", "compact"];

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
    <main className="h-full overflow-y-auto bg-zinc-950 px-4 py-3 text-zinc-100 sm:px-5">
      <header className="mb-3 border-y-4 border-double border-zinc-500 py-2">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="font-utility text-minimal font-medium uppercase tracking-[0.18em] text-zinc-500">
              Cross-platform design desk
            </p>
            <h1 className="font-masthead text-comfortable font-semibold sm:text-comfortable">
              Cheers Item Register
            </h1>
          </div>
          <p className="hidden max-w-56 text-right font-utility text-minimal font-medium uppercase leading-4 tracking-wider text-zinc-500 sm:block">
            One anatomy · Three densities
            <br />Web · iOS · Android
          </p>
        </div>
      </header>

      <section aria-labelledby="type-register" className="mb-4 grid border-y border-zinc-700 lg:grid-cols-3 lg:divide-x lg:divide-zinc-700">
        <div className="px-3 py-3">
          <p className="font-utility text-minimal font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Display · Opsz 60
          </p>
          <h2 id="type-register" className="mt-1 font-display text-comfortable font-semibold tracking-[-0.025em]">
            The Formal Edition · 正式版
          </h2>
          <p className="mt-1 font-utility text-compact text-zinc-500">Introductions · Hero titles · Major headings</p>
        </div>
        <div className="border-t border-zinc-700 px-3 py-3 lg:border-t-0">
          <p className="font-utility text-minimal font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Reading · Opsz 14
          </p>
          <p className="mt-1 font-reading text-regular leading-6 text-zinc-300">
            A sturdy classical rhythm keeps long messages calm. 稳健的宋体让长消息正式而易读。
          </p>
          <p className="mt-1 font-utility text-compact text-zinc-500">Messages · Previews · Long-form copy</p>
        </div>
        <div className="border-t border-zinc-700 px-3 py-3 lg:border-t-0">
          <p className="font-utility text-minimal font-semibold uppercase tracking-[0.16em] text-zinc-500">
            Utility · Source Sans 3
          </p>
          <p className="mt-2 font-utility text-compact font-semibold uppercase tracking-[0.08em] text-amber-300">
            Channel name · 频道名称 · Warning · Trace active
          </p>
          <p className="mt-2 font-utility text-compact text-zinc-500">Controls · Status · Trace labels</p>
        </div>
      </section>

      <section aria-labelledby="control-size-register" className="mb-4 border-y border-zinc-700 py-3">
        <div className="mb-2 flex items-baseline justify-between border-b border-zinc-600 pb-1">
          <h2 id="control-size-register" className="font-display text-comfortable font-semibold tracking-tight">
            Control Height Register
          </h2>
          <span className="font-utility text-minimal font-medium uppercase tracking-[0.16em] text-zinc-500">
            44 · 36 · 28 px
          </span>
        </div>
        <div className="grid gap-px bg-zinc-800 lg:grid-cols-3">
          {controlSizes.map((size) => (
            <ControlSizeProvider key={size} size={size}>
              <div className="space-y-2 bg-zinc-950 p-3">
                <p className="font-utility text-minimal font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  {size}
                </p>
                <EntityItem title="Aligned item" leading={<User className="h-4 w-4" />} />
                <div className="flex items-center gap-2">
                  <Button variant="secondary">Button</Button>
                  <IconButton label={`${size} add`}><Plus className="h-4 w-4" /></IconButton>
                  <Input aria-label={`${size} input`} placeholder="Input" />
                </div>
                <div role="tablist" className="flex items-center gap-1">
                  <TabOption label="Active" selected />
                  <TabOption label="Archive" selected={false} />
                </div>
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
        <h2 id="state-register" className="mb-2 px-1 font-utility text-compact font-semibold uppercase tracking-[0.1em] text-zinc-400">State register</h2>
        <div className="grid gap-px bg-zinc-800 lg:grid-cols-2">
          <ItemList className="bg-zinc-950 px-2">
            <NavigationItem title="Selected destination" subtitle="Current channel" selected onClick={() => undefined} />
            <EntityItem title="Disabled identity" subtitle="Unavailable on this platform" disabled onClick={() => undefined} />
          </ItemList>
          <ItemList className="bg-zinc-950 px-2">
            <OperationsItem
              title="Composite approval"
              subtitle="Critical status remains visible"
              criticalStatus={<span className="text-minimal font-semibold text-red-300">ERROR</span>}
              actions={<><Button variant="ghost" controlSize="compact">Inspect</Button><Button variant="danger" controlSize="compact">Reject</Button></>}
            />
            <OperationsItem
              title="Loading operation"
              subtitle="Actions retain the shared height"
              actions={<Button variant="secondary" controlSize="compact" loading>Loading</Button>}
            />
          </ItemList>
        </div>
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
                  className="font-display text-comfortable font-semibold capitalize tracking-tight"
                >
                  {level}
                </h2>
                <span className="font-utility text-minimal font-medium uppercase tracking-[0.16em] text-zinc-500">
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
                  <span className="rounded-sm bg-indigo-600 px-1.5 text-minimal font-bold text-white">
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
                status={<span className="font-utility text-minimal font-semibold text-indigo-300">BOT</span>}
              />
              <ItemRow
                kind="feedback"
                leading={<AlertTriangle className="h-5 w-5 text-amber-400" />}
                title="Connection degraded"
                subtitle="Messages remain readable while reconnecting."
                criticalStatus={
                  <span className="font-utility text-minimal font-semibold text-amber-300">
                    RETRYING
                  </span>
                }
              />
              <OperationsItem
                leading={<EditorialIcon name="approvalSeal" contentSize="large" className="text-amber-300" />}
                title="Deploy production change"
                subtitle="Approval required"
                criticalStatus={<span className="h-1.5 w-1.5 rounded-full bg-red-400" />}
                actions={<Button variant="ghost" controlSize="compact" className="px-2 text-amber-200">Review</Button>}
              />
              <WorkbenchItem
                leading={<EditorialIcon name="proof" contentSize="large" />}
                title="Release plan"
                subtitle="4 completed · 1 active"
                status={<span className="text-minimal text-emerald-400">ACTIVE</span>}
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
                  className="bg-zinc-800/60 text-regular text-zinc-300"
                  actions={
                    <IconButton label="Remove Cost" controlSize="compact">
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  }
                />
                <Button variant="plain" controlSize="regular" className="gap-1.5 bg-zinc-800/60 px-2 text-zinc-400">
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
            <p className="font-utility text-compact font-semibold uppercase tracking-[0.1em] text-zinc-500">
              CRUD collection pattern
            </p>
            <h2 id="collection-manager-register" className="font-display text-comfortable font-semibold tracking-tight">
              Search · Add · Edit · Delete
            </h2>
          </div>
          <p className="max-w-xl font-utility text-compact leading-5 text-zinc-500 sm:text-right">
            Browse is the resting state. Add inserts an editor first; edit replaces its row;
            delete replaces its row with confirmation. No detached form and no immediate destructive icon.
          </p>
        </div>
        <div className="mx-auto max-w-3xl">
          <CollectionManagerDemo />
        </div>
      </section>

      <section aria-labelledby="specialized-register" className="mt-4 grid border-y border-zinc-700 lg:grid-cols-2 lg:divide-x lg:divide-zinc-700">
        <ItemSection label="Specialized file tree" className="px-3 py-3">
          <FileTreeItem depth={0} expanded disclosure={<span aria-hidden>⌄</span>} leading={<EditorialIcon name="archive" contentSize="regular" />} title="frontend" />
          <FileTreeItem depth={1} selected leading={<EditorialIcon name="attachment" contentSize="regular" />} title="ItemGallery.tsx" />
        </ItemSection>
        <div className="border-t border-zinc-700 px-3 py-3 lg:border-t-0">
          <h2 id="specialized-register" className="mb-1 font-utility text-compact font-semibold uppercase tracking-[0.1em] text-zinc-400">Specialized diff</h2>
          <ItemList className="overflow-x-auto bg-zinc-950">
            <DiffLineItem controlSize="compact" tone="remove" lineNumber="18" marker="−" content="border-radius: 12px;" />
            <DiffLineItem controlSize="regular" tone="add" lineNumber="18" marker="+" content="border-radius: 4px;" />
            <DiffLineItem controlSize="comfortable" lineNumber="19" marker=" " content="font-family: var(--font-utility);" />
          </ItemList>
        </div>
      </section>

      <section aria-labelledby="editorial-icon-register" className="mt-4 border-y border-zinc-700 py-3">
        <div className="mb-2 flex items-baseline justify-between border-b border-zinc-600 pb-1">
          <h2 id="editorial-icon-register" className="font-display text-comfortable font-semibold tracking-tight">
            Editorial Icon Register
          </h2>
          <span className="font-utility text-minimal font-medium uppercase tracking-[0.16em] text-zinc-500">
            24 grid · 1.75 stroke · issue 02
          </span>
        </div>
        <div className="grid grid-cols-2 border-l border-t border-zinc-700 sm:grid-cols-4 lg:grid-cols-8">
          {editorialIconNames.map((name, index) => (
            <figure
              key={name}
              className="m-0 min-h-24 border-b border-r border-zinc-700 px-2 py-3"
            >
              <div className="mb-3 flex items-start justify-between text-zinc-200">
                <EditorialIcon name={name} title={iconLabels[name]} contentSize="large" />
                <span className="font-utility text-minimal tabular-nums text-zinc-600">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <figcaption className="font-reading text-compact leading-4 text-zinc-400">
                {iconLabels[name]}
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
    </main>
  );
}
