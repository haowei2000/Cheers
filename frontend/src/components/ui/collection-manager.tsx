import type { ReactNode } from "react";
import { AlertTriangle, Plus, Search } from "lucide-react";
import { Button } from "./button";
import { ActionButton } from "./action-button";
import { controlIconClasses, controlMinHeightClasses } from "./control-size";
import { Input } from "./input";
import { ItemList, OperationsItem } from "./item";
import type { PresentationLevel } from "./presentation";
import type { ControlSize } from "./control-size";
import { cn } from "@/lib/cn";

export type CollectionMode =
  | { kind: "browse" }
  | { kind: "add" }
  | { kind: "edit"; id: string }
  | { kind: "delete"; id: string };

/**
 * Canonical shell for searchable, editable collections such as Claims, Links,
 * Grants, Passkeys, and Sessions. Business rows remain OperationsItems; add,
 * edit, and delete are explicit list modes rather than unrelated page forms.
 */
export function CollectionManager({
  label,
  count,
  query,
  onQueryChange,
  searchPlaceholder = "Search items",
  addLabel,
  onAdd,
  addDisabled,
  showAdd = true,
  headerAction,
  presentationLevel = "medium",
  controlSize = "regular",
  children,
  className,
}: {
  label: ReactNode;
  count?: number;
  query: string;
  onQueryChange: (query: string) => void;
  searchPlaceholder?: string;
  addLabel: string;
  onAdd: () => void;
  addDisabled?: boolean;
  showAdd?: boolean;
  headerAction?: ReactNode;
  presentationLevel?: PresentationLevel;
  controlSize?: ControlSize;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0", className)}>
      <header
        className={cn(
          "flex items-center gap-2 px-1 font-utility text-compact font-semibold uppercase tracking-[0.1em] text-zinc-400",
          controlMinHeightClasses[controlSize],
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {headerAction}
        {typeof count === "number" && (
          <span className="font-normal tabular-nums text-zinc-400">{count}</span>
        )}
      </header>

      <div className="flex min-w-0 items-center gap-2 px-1 pb-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{searchPlaceholder}</span>
          <Search
            aria-hidden
            className={cn(
              controlIconClasses[controlSize],
              "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400",
            )}
          />
          <Input
            controlSize={controlSize}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="pl-9"
          />
        </label>
        {showAdd && (
          <Button
            content="iconText"
            action="add"
            type="button"
            aria-label={addLabel}
            controlSize={controlSize}
            variant="secondary"
            disabled={addDisabled}
            onClick={onAdd}
            className="shrink-0"
          >
            <Plus className={controlIconClasses[controlSize]} />
          </Button>
        )}
      </div>

      <ItemList presentationLevel={presentationLevel} controlSize={controlSize}>{children}</ItemList>
    </section>
  );
}

/** Add-by-search mode used by member, destination, mention, and session pickers. */
export function CollectionPickerItem({
  title,
  query,
  onQueryChange,
  placeholder,
  onCancel,
  children,
}: {
  title: ReactNode;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div role="listitem" data-collection-mode="add" className="rounded-sm bg-zinc-900/80 px-2 py-2">
      <div className={cn("flex items-center gap-2", controlMinHeightClasses.compact)}>
        <span className="min-w-0 flex-1 truncate font-utility text-regular font-semibold text-zinc-100">{title}</span>
        <ActionButton action="cancel" context="form" controlSize="compact" onClick={onCancel} />
      </div>
      <label className="relative mt-1 block min-w-0">
        <span className="sr-only">{placeholder}</span>
        <Search
          aria-hidden
          className={cn(controlIconClasses.regular, "pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400")}
        />
        <Input
          controlSize="regular"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          className="pl-9"
        />
      </label>
      <ItemList presentationLevel="medium" controlSize="regular" className="mt-1 max-h-44 overflow-y-auto">
        {children}
      </ItemList>
    </div>
  );
}

/** Add/edit mode occupies one list position; edit replaces the original row. */
export function CollectionEditorItem({
  mode,
  title,
  children,
  onCancel,
  onSave,
  saving,
  saveDisabled,
}: {
  mode: "add" | "edit";
  title: ReactNode;
  children: ReactNode;
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
}) {
  return (
    <div
      role="listitem"
      data-collection-mode={mode}
      className="rounded-sm bg-zinc-900/80 px-2 py-2"
    >
      <div className={cn("flex items-center gap-2", controlMinHeightClasses.compact)}>
        <span className="min-w-0 flex-1 truncate font-utility text-regular font-semibold text-zinc-100">
          {title}
        </span>
        <span className="font-utility text-compact font-semibold uppercase tracking-wide text-zinc-400">
          {mode}
        </span>
      </div>
      <div className="grid min-w-0 gap-2 py-1 sm:grid-cols-2">{children}</div>
      <div className="flex justify-end gap-1 pt-1">
        {mode === "edit" ? (
          <>
            <ActionButton action="cancel" context="inlineEdit" accessibleLabel="Cancel editing item" controlSize="compact" onClick={onCancel} disabled={saving} />
            <ActionButton action="save" context="inlineEdit" accessibleLabel="Save item" controlSize="compact" loading={saving} disabled={saveDisabled} onClick={onSave} />
          </>
        ) : (
          <>
            <ActionButton action="cancel" context="form" controlSize="compact" onClick={onCancel} disabled={saving} />
            <ActionButton action="create" context="form" controlSize="compact" loading={saving} disabled={saveDisabled} onClick={onSave} />
          </>
        )}
      </div>
    </div>
  );
}

/** Delete never fires from a lone icon: the row changes into confirmation mode. */
export function CollectionDeleteItem({
  title,
  description,
  onCancel,
  onConfirm,
  deleting,
}: {
  title: ReactNode;
  description: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  deleting?: boolean;
}) {
  return (
    <OperationsItem
      presentationLevel="medium"
      controlSize="regular"
      leading={<AlertTriangle className="h-4 w-4 text-red-400" />}
      title={<span title={String(description)}>{title}</span>}
      criticalStatus={(
        <span className="font-utility text-compact font-semibold uppercase tracking-wide text-red-400">
          Delete?
        </span>
      )}
      actions={(
        <>
          <ActionButton action="cancel" context="confirmation" controlSize="compact" onClick={onCancel} disabled={deleting} />
          <ActionButton action="delete" context="confirmation" controlSize="compact" loading={deleting} onClick={onConfirm} />
        </>
      )}
    />
  );
}

export function CollectionEmptyItem({
  query,
  onClear,
}: {
  query?: string;
  onClear?: () => void;
}) {
  const searching = Boolean(query?.trim());
  return (
    <OperationsItem
      presentationLevel="medium"
      controlSize="regular"
      title={searching ? "No matching items" : "No items yet"}
      actions={searching && onClear ? (
          <Button action="clear" type="button" variant="ghost" controlSize="compact" onClick={onClear} />
        ) : undefined}
    />
  );
}
