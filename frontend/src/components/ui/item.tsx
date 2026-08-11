import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  usePresentationLevel,
  type PresentationLevel,
} from "@/components/ui/presentation";

export type ItemKind =
  | "identity"
  | "navigation"
  | "conversation"
  | "context"
  | "operations"
  | "workbench"
  | "feedback";

interface ItemRowBaseProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "onClick"> {
  kind: ItemKind;
  title: ReactNode;
  leading?: ReactNode;
  subtitle?: ReactNode;
  metadata?: ReactNode;
  preview?: ReactNode;
  criticalStatus?: ReactNode;
  status?: ReactNode;
  trailing?: ReactNode;
  /** Interactive controls for a composite row. Composite rows cannot also be full-row buttons. */
  actions?: ReactNode;
  presentationLevel?: PresentationLevel;
  selected?: boolean;
}

export type ItemRowProps = ItemRowBaseProps &
  (
    | {
        /** Render one semantic full-row button. */
        onClick: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
        actions?: never;
      }
    | {
        /** Composite rows remain containers and expose controls through `actions`. */
        onClick?: undefined;
        actions?: ReactNode;
      }
  );

/**
 * Canonical anatomy for semantic list items across navigation, identity,
 * conversation, operations, and workbench surfaces.
 */
export function ItemRow({
  kind,
  title,
  leading,
  subtitle,
  metadata,
  preview,
  criticalStatus,
  status,
  trailing,
  actions,
  presentationLevel,
  selected,
  className,
  onClick,
  disabled,
  ...buttonProps
}: ItemRowProps) {
  const level = usePresentationLevel(presentationLevel);
  const content = (
    <>
      {leading && <span className="flex flex-shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-utility text-sm font-medium tracking-normal text-current">
            {title}
          </span>
          {criticalStatus}
          {level !== "minimal" && status}
        </span>
        {level !== "minimal" && subtitle && (
          <span className="mt-0.5 block truncate text-xs text-zinc-400">{subtitle}</span>
        )}
        {level === "max" && metadata && (
          <span className="mt-0.5 block truncate text-[11px] text-zinc-400">{metadata}</span>
        )}
        {level === "max" && preview && (
          <span className="mt-1 block line-clamp-2 font-reading text-sm leading-relaxed text-zinc-300">
            {preview}
          </span>
        )}
      </span>
      {trailing && <span className="ml-auto flex flex-shrink-0 items-center">{trailing}</span>}
      {actions && (
        <span className="ml-auto flex flex-shrink-0 items-center gap-1" data-item-actions="">
          {actions}
        </span>
      )}
    </>
  );
  const classes = cn(
    "group/item flex w-full min-w-0 items-center gap-2 rounded-sm border-b border-l-2 border-b-zinc-800/90 px-2 text-left transition-colors duration-150",
    level === "max" ? "min-h-12 py-2" : level === "medium" ? "min-h-9 py-1" : "min-h-7 py-0.5",
    "max-md:min-h-11 max-md:py-1.5",
    selected
      ? "border-l-zinc-200 bg-zinc-900 text-zinc-100"
      : "border-l-transparent text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200",
    disabled && "pointer-events-none opacity-50",
    className
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-item-kind={kind}
        data-presentation-level={level}
        aria-pressed={selected || undefined}
        className={cn(
          classes,
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        )}
        onClick={onClick}
        disabled={disabled}
        {...buttonProps}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      data-item-kind={kind}
      data-presentation-level={level}
      className={classes}
    >
      {content}
    </div>
  );
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SemanticItemProps = DistributiveOmit<ItemRowProps, "kind">;

export function EntityItem(props: SemanticItemProps) {
  return <ItemRow kind="identity" {...props} />;
}

export function NavigationItem(props: SemanticItemProps) {
  return <ItemRow kind="navigation" {...props} />;
}

export function OperationsItem(props: SemanticItemProps) {
  return <ItemRow kind="operations" {...props} />;
}

export function WorkbenchItem(props: SemanticItemProps) {
  return <ItemRow kind="workbench" {...props} />;
}

export function ItemList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="list" className={cn("min-w-0", className)} {...props} />;
}

export function ItemSection({
  label,
  action,
  children,
  className,
}: {
  label: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 space-y-1", className)}>
      <header className="flex min-h-7 items-center gap-2 px-1 font-utility text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-400">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {action}
      </header>
      <ItemList>{children}</ItemList>
    </section>
  );
}

export function FileTreeItem({
  depth,
  title,
  leading,
  disclosure,
  actions,
  selected,
  onClick,
  expanded,
}: {
  depth: number;
  title: ReactNode;
  leading?: ReactNode;
  disclosure?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  expanded?: boolean;
}) {
  const content = <>{disclosure}{leading}<span className="min-w-0 flex-1 truncate">{title}</span></>;
  return (
    <div
      role="treeitem"
      aria-selected={selected || undefined}
      className={cn(
        "group/item flex min-h-7 min-w-0 items-center gap-1 rounded-sm pr-2 font-utility text-sm text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200 max-md:min-h-11",
        selected && "bg-zinc-900 text-zinc-100"
      )}
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-expanded={expanded}
          aria-current={selected ? "true" : undefined}
          className="flex min-h-7 min-w-0 flex-1 items-center gap-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 max-md:min-h-11"
        >
          {content}
        </button>
      ) : content}
      {actions && <span className="flex items-center gap-1">{actions}</span>}
    </div>
  );
}

export function DiffLineItem({
  marker,
  content,
  tone = "context",
  lineNumber,
}: {
  marker?: ReactNode;
  content: ReactNode;
  tone?: "add" | "remove" | "context";
  lineNumber?: ReactNode;
}) {
  return (
    <div
      role="listitem"
      data-diff-tone={tone}
      className={cn(
        "flex min-h-6 whitespace-pre px-2 font-mono text-xs",
        tone === "add" && "bg-emerald-950/30 text-emerald-200",
        tone === "remove" && "bg-rose-950/30 text-rose-200",
        tone === "context" && "text-zinc-400"
      )}
    >
      {lineNumber && <span className="mr-2 w-10 select-none text-right text-zinc-600">{lineNumber}</span>}
      {marker && <span className="mr-2 flex-shrink-0 select-none">{marker}</span>}
      <span>{content}</span>
    </div>
  );
}

export function ItemChip({
  label,
  leading,
  criticalStatus,
  presentationLevel,
  className,
}: {
  label: ReactNode;
  leading?: ReactNode;
  criticalStatus?: ReactNode;
  presentationLevel?: PresentationLevel;
  className?: string;
}) {
  const level = usePresentationLevel(presentationLevel);
  return (
    <span
      data-item-kind="context"
      data-presentation-level={level}
      className={cn(
        "inline-flex min-w-0 items-center rounded-sm border border-zinc-700/80 bg-transparent font-utility tracking-tight text-zinc-400",
        level === "max"
          ? "gap-1.5 px-2 py-0.5 text-xs"
          : level === "medium"
            ? "gap-1 px-1.5 py-0.5 text-[11px]"
            : "gap-1 px-1 py-0.5 text-[10px]",
        className
      )}
    >
      {leading}
      <span className={cn("truncate", level === "max" ? "max-w-64" : "max-w-48")}>
        {label}
      </span>
      {criticalStatus}
    </span>
  );
}
