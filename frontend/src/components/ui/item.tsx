import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  PresentationProvider,
  usePresentationLevel,
  type PresentationLevel,
} from "@/components/ui/presentation";
import {
  ControlSizeProvider,
  controlMinHeightClasses,
  controlTextClasses,
  useControlSize,
  type ControlSize,
} from "@/components/ui/control-size";

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
  controlSize?: ControlSize;
  selected?: boolean;
  /** Use presentation only when an ItemGroup owns the surrounding listitem role. */
  containerRole?: "listitem" | "presentation";
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
  controlSize,
  selected,
  containerRole = "listitem",
  className,
  onClick,
  disabled,
  ...buttonProps
}: ItemRowProps) {
  const level = usePresentationLevel(presentationLevel);
  const size = useControlSize(controlSize);
  const content = (
    <>
      {leading && <span className="flex flex-shrink-0 items-center">{leading}</span>}
      <span className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate font-utility font-medium tracking-normal text-current", controlTextClasses[size])}>
            {title}
          </span>
          {criticalStatus}
          {level !== "minimal" && status}
        </span>
        {level !== "minimal" && subtitle && (
          <span className="mt-1 block truncate text-caption">{subtitle}</span>
        )}
        {level === "max" && metadata && (
          <span className="mt-1 block truncate text-caption">{metadata}</span>
        )}
        {level === "max" && preview && (
          <span className="mt-1 block line-clamp-2 text-message">
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
    controlMinHeightClasses[size],
    size === "compact" ? "py-1" : size === "regular" ? "py-1" : "py-2",
    selected
      ? kind === "navigation"
        ? "border-l-zinc-200 bg-zinc-800 text-zinc-100"
        : "border-l-zinc-200 bg-zinc-900 text-zinc-100"
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
        data-control-size={size}
        aria-current={kind === "navigation" && selected ? "page" : undefined}
        aria-pressed={kind !== "navigation" && selected ? true : undefined}
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
      role={containerRole}
      data-item-kind={kind}
      data-presentation-level={level}
      data-control-size={size}
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

interface ItemListProps extends HTMLAttributes<HTMLDivElement> {
  /** Information anatomy inherited by every semantic item in this list. */
  presentationLevel?: PresentationLevel;
  /** Physical rhythm inherited by every semantic item in this list. */
  controlSize?: ControlSize;
}

export function ItemList({
  className,
  presentationLevel,
  controlSize,
  ...props
}: ItemListProps) {
  const level = usePresentationLevel(presentationLevel);
  const size = useControlSize(controlSize);
  return (
    <PresentationProvider level={level} responsive={false}>
      <ControlSizeProvider size={size}>
        <div
          role="list"
          data-presentation-level={level}
          data-control-size={size}
          className={cn("min-w-0", className)}
          {...props}
        />
      </ControlSizeProvider>
    </PresentationProvider>
  );
}

/** One list position that owns a semantic summary row plus expandable detail. */
export function ItemGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="listitem" className={cn("min-w-0", className)} {...props} />;
}

export function ItemSection({
  label,
  action,
  description,
  children,
  className,
  controlSize,
  headerControlSize = "compact",
  presentationLevel,
}: {
  label: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  controlSize?: ControlSize;
  /** Section labels are typographic dividers, not list controls. */
  headerControlSize?: ControlSize;
  presentationLevel?: PresentationLevel;
}) {
  const size = useControlSize(controlSize);
  const level = usePresentationLevel(presentationLevel);
  return (
    <section
      data-presentation-level={level}
      data-control-size={size}
      className={cn("min-w-0 space-y-1", className)}
    >
      <header className={cn("flex items-center gap-2 px-1 text-section-label", controlMinHeightClasses[headerControlSize])}>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {action}
      </header>
      {description && (
        <p className="px-1 text-caption">{description}</p>
      )}
      <ItemList presentationLevel={level} controlSize={size}>{children}</ItemList>
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
  controlSize,
}: {
  depth: number;
  title: ReactNode;
  leading?: ReactNode;
  disclosure?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  expanded?: boolean;
  controlSize?: ControlSize;
}) {
  const size = useControlSize(controlSize);
  const content = <>{disclosure}{leading}<span className="min-w-0 flex-1 truncate">{title}</span></>;
  return (
    <div
      role="treeitem"
      data-control-size={size}
      aria-selected={selected || undefined}
      className={cn(
        "group/item flex min-w-0 items-center gap-1 rounded-sm pr-2 font-utility text-regular text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200",
        controlMinHeightClasses[size],
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
          className={cn("flex min-w-0 flex-1 items-center gap-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500", controlMinHeightClasses[size])}
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
  controlSize,
}: {
  marker?: ReactNode;
  content: ReactNode;
  tone?: "add" | "remove" | "context";
  lineNumber?: ReactNode;
  controlSize?: ControlSize;
}) {
  const size = useControlSize(controlSize);
  return (
    <div
      role="listitem"
      data-diff-tone={tone}
      data-control-size={size}
      className={cn(
        "flex whitespace-pre px-2 font-mono text-compact",
        controlMinHeightClasses[size],
        tone === "add" && "bg-emerald-950/30 text-emerald-200",
        tone === "remove" && "bg-rose-950/30 text-rose-200",
        tone === "context" && "text-zinc-400"
      )}
    >
      {lineNumber && <span className="mr-2 w-10 select-none text-right text-zinc-400">{lineNumber}</span>}
      {marker && <span className="mr-2 flex-shrink-0 select-none">{marker}</span>}
      <span>{content}</span>
    </div>
  );
}

export function ItemChip({
  label,
  leading,
  criticalStatus,
  actions,
  presentationLevel,
  controlSize,
  className,
}: {
  label: ReactNode;
  leading?: ReactNode;
  criticalStatus?: ReactNode;
  actions?: ReactNode;
  presentationLevel?: PresentationLevel;
  controlSize?: ControlSize;
  className?: string;
}) {
  const level = usePresentationLevel(presentationLevel);
  const size = useControlSize(controlSize);
  return (
    <span
      data-item-kind="context"
      data-presentation-level={level}
      data-control-size={size}
      className={cn(
        "inline-flex min-w-0 items-center rounded-sm bg-transparent font-utility tracking-tight text-zinc-400",
        controlMinHeightClasses[size],
        level === "max" ? "gap-2 px-2 text-compact" : level === "medium" ? "gap-1 px-2 text-compact" : "gap-1 px-1 text-minimal",
        className
      )}
    >
      {leading}
      <span className={cn("truncate", level === "max" ? "max-w-64" : "max-w-48")}>
        {label}
      </span>
      {criticalStatus}
      {actions && (
        <span data-item-actions className="ml-auto inline-flex flex-shrink-0 items-center gap-1">
          {actions}
        </span>
      )}
    </span>
  );
}
