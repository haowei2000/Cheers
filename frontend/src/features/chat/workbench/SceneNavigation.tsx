import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import { Folder, Plus, type LucideIcon } from "lucide-react";
import { Button as UiButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownSelect, type DropdownSelectOption } from "@/components/ui/dropdown-select";
import { AddContextIcon, TabIcon } from "@/components/ui/editorial-icons";
import { useContextSurface } from "@/components/ui/context-actions";
import type { AdaptiveControlPresentation } from "@/components/ui/adaptive-control-group";
import { cn } from "@/lib/cn";
import { ResponsiveActionButton } from "@/components/ui/responsive-action-button";
import { workbenchControlSize } from "./workbench-control";
import type { TemplateManifest } from "./manifest";
import {
  basename,
  metaFor,
  sceneTabContextActions,
  type SceneIconComponent,
} from "./sceneState";

export function SceneTab({
  label,
  Icon,
  iconColor,
  selected,
  presentation,
  onSelect,
  onShowRaw,
  onAddToContext,
  contextAdded,
  contextAvailable,
}: {
  label: string;
  Icon: SceneIconComponent;
  iconColor: string;
  selected: boolean;
  presentation: Exclude<AdaptiveControlPresentation, "collapsed">;
  onSelect: () => void;
  onShowRaw: () => void;
  onAddToContext: () => void;
  contextAdded: boolean;
  contextAvailable: boolean;
}) {
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => sceneTabContextActions(label, onSelect, onShowRaw, onAddToContext, contextAdded, contextAvailable),
  });
  const contextHandlers = {
    onContextMenu: contextSurface.onContextMenu,
    onKeyDown: contextSurface.onKeyDown,
    onPointerDown: contextSurface.onPointerDown,
    onPointerMove: contextSurface.onPointerMove,
    onPointerUp: contextSurface.onPointerUp,
    onPointerCancel: contextSurface.onPointerCancel,
    onPointerLeave: contextSurface.onPointerLeave,
    onClickCapture: contextSurface.onClickCapture,
  };

  const iconOnly = presentation === "icon";
  return (
    <UiButton
      ref={surfaceRef}
      variant="plain"
      content={iconOnly ? "icon" : "text"}
      role="tab"
      aria-selected={selected}
      selected={selected}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      type="button"
      onClick={onSelect}
      controlSize={workbenchControlSize.tab}
      className={cn(
        "shrink-0 gap-1 rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-700/60 dark:focus-visible:ring-zinc-300/60 hover:bg-transparent",
        selected
          ? "border-content-strong text-content-strong font-semibold"
          : "border-transparent text-content-primary hover:text-content-strong",
      )}
      {...contextHandlers}
    >
      {presentation !== "text" && <Icon className={cn("h-4 w-4", selected && iconColor)} aria-hidden="true" />}
      {!iconOnly && <span className="truncate">{label}</span>}
    </UiButton>
  );
}

export function AddCollectionControl({
  onOpenNew,
  content = "icon",
}: {
  onOpenNew: () => void;
  content?: "text" | "icon";
}) {
  return (
    <UiButton
      action="add"
      type="button"
      onClick={onOpenNew}
      content={content === "icon" ? "icon" : "iconText"}
      controlWidth={content === "icon" ? "slot" : "content"}
      variant="plain"
      aria-label="Add Collection"
      title="Add Collection"
      controlSize={workbenchControlSize.tab}
      className="shrink-0"
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      {content !== "icon" && <span>Add Collection</span>}
    </UiButton>
  );
}

export function NewCollectionDialog({
  isOpen,
  available,
  onSelect,
  onLoad,
  onClose,
}: {
  isOpen: boolean;
  available: TemplateManifest[];
  onSelect: (manifest: TemplateManifest) => void;
  onLoad: () => void;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <Dialog title="New Collection" onClose={onClose} maxWidth="max-w-lg">
      <div className="flex flex-col gap-4">
        <p className="text-compact text-content-secondary">
          Select a template group to add to this workspace.
        </p>
        <div
          role="listbox"
          aria-label="Available templates"
          className="flex flex-col gap-1 max-h-[60vh] overflow-y-auto -mx-1 px-1"
        >
          {available.map((template) => {
            const meta = metaFor(template.id, template.icon);
            const Icon = meta.Icon;
            return (
              <UiButton
                key={template.id}
                role="option"
                type="button"
                variant="plain"
                content="text"
                controlWidth="fill"
                controlSize="comfortable"
                onClick={() => {
                  onSelect(template);
                  onClose();
                }}
                className="justify-start gap-3 rounded text-left hover:bg-control/60"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-control text-content-primary">
                  <Icon className={cn("h-4 w-4", meta.color)} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 py-1">
                  <div className="text-regular font-medium text-content-strong truncate">
                    {template.title}
                  </div>
                  {meta.subtitle && (
                    <div className="text-compact text-content-muted truncate">
                      {meta.subtitle}
                    </div>
                  )}
                </div>
              </UiButton>
            );
          })}
          {available.length === 0 && (
            <div className="py-6 text-center text-compact text-content-muted">
              All available templates have already been added to this workspace.
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-control/80 pt-3">
          <ResponsiveActionButton
            action="upload"
            context="toolbar"
            variant="secondary"
            wideLabel="Load .cheers-extension…"
            onClick={() => {
              onClose();
              onLoad();
            }}
            controlSize="compact"
          />
          <UiButton
            action="cancel"
            type="button"
            variant="plain"
            onClick={onClose}
            controlSize="compact"
          >
            Cancel
          </UiButton>
        </div>
      </div>
    </Dialog>
  );
}

export function AddTabControl({
  candidates,
  onSelect,
  content = "icon",
}: {
  candidates: string[];
  onSelect: (path: string) => void;
  content?: "text" | "icon";
}) {
  if (!candidates.length) return null;
  return (
    <DropdownSelect
      ariaLabel="Open Tab"
      label="Open Tab"
      leading={<TabIcon className="h-4 w-4 text-content-secondary" aria-hidden="true" />}
      content={content}
      options={[]}
      actions={candidates.map((path) => ({
        value: path,
        label: basename(path),
        leading: <TabIcon className="h-4 w-4 text-content-secondary" aria-hidden="true" />,
      }))}
      onSelect={() => undefined}
      onAction={onSelect}
      placement="down"
      controlSize={workbenchControlSize.tab}
      controlWidth="fill"
      className="shrink-0"
    />
  );
}

export function WorkbenchHierarchyNavigation({
  availableWidth,
  collections,
  activeCollection,
  collectionTitle,
  collectionIcon,
  hasAvailableTemplates,
  onSelectCollection,
  onOpenNew,
  onLoadCollection,
  onShowRaw,
}: {
  availableWidth: number;
  collections: Array<{ id: string; label: string; Icon: LucideIcon | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }> }>;
  activeCollection: string;
  collectionTitle: string;
  collectionIcon: LucideIcon | ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  hasAvailableTemplates: boolean;
  onSelectCollection: (id: string) => void;
  onOpenNew: () => void;
  onLoadCollection: () => void;
  onShowRaw: () => void;
}) {
  const textProbe = useRef<HTMLDivElement>(null);
  const [requiredTextWidth, setRequiredTextWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const measure = () => setRequiredTextWidth(textProbe.current?.scrollWidth ?? Number.POSITIVE_INFINITY);
    measure();
    const observer = new ResizeObserver(measure);
    if (textProbe.current) observer.observe(textProbe.current);
    return () => observer.disconnect();
  }, [collections.length, collectionTitle]);
  const iconOnly = availableWidth < requiredTextWidth;
  const CollectionIcon = collectionIcon;

  const collectionActions: DropdownSelectOption[] = [
    ...(hasAvailableTemplates
      ? [
          {
            value: "new-collection",
            label: "New Collection…",
            leading: <Plus className="h-4 w-4" aria-hidden="true" />,
          },
        ]
      : []),
    { value: "load", label: "Load .cheers-extension…", leading: <Folder className="h-4 w-4" aria-hidden="true" /> },
  ];
  const collectionOptions: DropdownSelectOption[] = [
    ...collections.map(({ id, label, Icon }) => ({
      value: `collection:${id}`,
      label,
      leading: <Icon className="h-4 w-4" aria-hidden="true" />,
    })),
    { value: "raw", label: "Raw workspace files", leading: <Folder className="h-4 w-4" aria-hidden="true" /> },
  ];
  const chooseCollection = (value: string) => {
    if (value === "raw") return onShowRaw();
    onSelectCollection(value.slice("collection:".length));
  };
  const runCollectionAction = (value: string) => {
    if (value === "load") return onLoadCollection();
    if (value === "new-collection") return onOpenNew();
  };
  const controls = (probe = false, icons = iconOnly) => (
    <div className="flex min-w-0 flex-nowrap items-center gap-1" aria-hidden={probe || undefined}>
      <DropdownSelect
        ariaLabel={`Collection: ${collectionTitle}`}
        label={collectionTitle || "Collections"}
        leading={<CollectionIcon className="h-4 w-4" aria-hidden="true" />}
        content={icons ? "icon" : "text"}
        value={`collection:${activeCollection}`}
        options={collectionOptions}
        onSelect={chooseCollection}
        actions={collectionActions}
        onAction={runCollectionAction}
        placement="down"
        controlSize={workbenchControlSize.chrome}
        controlWidth="slot"
        className="max-w-64 bg-transparent hover:bg-control/50 text-content-primary hover:text-content-strong"
      />
    </div>
  );

  return (
    <div className="relative min-w-0 max-w-full overflow-hidden">
      {controls()}
      <div {...({ inert: "" } as Record<string, string>)} className="pointer-events-none absolute invisible w-max" ref={textProbe}>{controls(true, false)}</div>
    </div>
  );
}

export function ItemTab({
  label,
  selected,
  presentation,
  contextAdded,
  onSelect,
  onAddToContext,
}: {
  label: string;
  selected: boolean;
  presentation: Exclude<AdaptiveControlPresentation, "collapsed">;
  contextAdded: boolean;
  onSelect: () => void;
  onAddToContext: () => void;
}) {
  const surfaceRef = useRef<HTMLButtonElement>(null);
  const contextSurface = useContextSurface({
    surfaceRef,
    actions: () => [{
      id: "add-context",
      label: contextAdded ? "Already added to context" : "Add to context",
      icon: <AddContextIcon className="h-4 w-4" />,
      disabled: contextAdded,
      run: onAddToContext,
    }],
  });

  return (
    <UiButton
      ref={surfaceRef}
      variant="plain"
      role="tab"
      aria-selected={selected}
      selected={selected}
      aria-label={presentation === "icon" ? label : undefined}
      title={presentation === "icon" ? label : undefined}
      content={presentation === "icon" ? "icon" : "text"}
      type="button"
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      controlSize={workbenchControlSize.tab}
      className={cn(
        "shrink-0 gap-1 rounded-none border-b-2 bg-transparent ring-0 shadow-none -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-zinc-700/60 dark:focus-visible:ring-zinc-300/60 hover:bg-transparent",
        selected
          ? "border-content-strong text-content-strong font-semibold"
          : "border-transparent text-content-primary hover:text-content-strong",
      )}
      onContextMenu={contextSurface.onContextMenu}
      onKeyDown={contextSurface.onKeyDown}
      onPointerDown={contextSurface.onPointerDown}
      onPointerMove={contextSurface.onPointerMove}
      onPointerUp={contextSurface.onPointerUp}
      onPointerCancel={contextSurface.onPointerCancel}
      onPointerLeave={contextSurface.onPointerLeave}
      onClickCapture={contextSurface.onClickCapture}
    >
      {presentation === "icon" ? <TabIcon className="h-4 w-4" aria-hidden="true" /> : label}
    </UiButton>
  );
}
