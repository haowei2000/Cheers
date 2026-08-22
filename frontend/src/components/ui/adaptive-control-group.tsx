import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Ellipsis, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import type { ControlSize } from "./control-size";
import { DropdownSelect } from "./dropdown-select";
import { MenuOption } from "./menu-option";
import { PopoverPanel, usePopoverDismiss } from "./popover";

export type AdaptiveControlPresentation = "iconText" | "text" | "icon" | "collapsed";

export interface AdaptiveControlItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  badge?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  priority?: "primary" | "secondary";
  onSelect?: () => void;
  /** Compound controls can retain a custom full rendering and overflow row. */
  control?: ReactNode;
  overflow?: ReactNode;
}

export interface AdaptiveControlWidths {
  iconText: number;
  text: number;
  icon: number;
  collapsed: number;
}

export function chooseAdaptiveControlPresentation(
  availableWidth: number,
  widths: AdaptiveControlWidths,
  order: AdaptiveControlPresentation[] = ["iconText", "text", "icon", "collapsed"],
): AdaptiveControlPresentation {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return order[0] ?? "collapsed";
  return order.find((candidate) => widths[candidate] <= availableWidth + 0.5)
    ?? order.at(-1)
    ?? "collapsed";
}

function ControlBadge({ children }: { children: ReactNode }) {
  return (
    <span className="min-w-4 rounded-sm bg-zinc-700 px-1 text-center text-minimal tabular-nums text-content-secondary">
      {children}
    </span>
  );
}

function AdaptiveItemControl({
  item,
  presentation,
  kind,
  controlSize,
}: {
  item: AdaptiveControlItem;
  presentation: Exclude<AdaptiveControlPresentation, "collapsed">;
  kind: "navigation" | "actions";
  controlSize: ControlSize;
}) {
  if (item.control) return <>{item.control}</>;
  const Icon = item.icon;
  const iconOnly = presentation === "icon" && Icon != null;
  const showIcon = presentation !== "text" && Icon != null;
  const showLabel = !iconOnly;
  return (
    <Button
      type="button"
      variant="plain"
      content={iconOnly ? "icon" : "text"}
      controlWidth="content"
      controlSize={controlSize}
      role={kind === "navigation" ? "tab" : undefined}
      aria-selected={kind === "navigation" ? item.selected : undefined}
      selected={kind === "actions" ? item.selected : undefined}
      aria-label={iconOnly ? item.label : undefined}
      title={iconOnly ? item.label : undefined}
      disabled={item.disabled}
      onClick={item.onSelect}
      className={cn(
        "gap-1 rounded-sm px-2 text-content-primary hover:text-content-strong",
        item.selected && "bg-zinc-700 text-content-strong",
      )}
    >
      {showIcon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
      {showLabel && <span className="truncate">{item.label}</span>}
      {item.badge != null && <ControlBadge>{item.badge}</ControlBadge>}
    </Button>
  );
}

function OverflowControl({
  items,
  controlSize,
}: {
  items: AdaptiveControlItem[];
  controlSize: ControlSize;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), rootRef);
  return (
    <div ref={rootRef} className="relative inline-flex">
      <Button
        type="button"
        variant="plain"
        content="icon"
        controlSize={controlSize}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        selected={open}
        onClick={() => setOpen((current) => !current)}
        className="text-content-primary hover:text-content-strong"
      >
        <Ellipsis className="h-4 w-4" aria-hidden="true" />
      </Button>
      {open && (
        <PopoverPanel placement="down" align="end" className="w-60 p-1">
          <div
            role="menu"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
          >
            {items.map((item) => item.overflow ?? (
              <MenuOption
                key={item.id}
                label={item.label}
                leading={item.icon ? <item.icon className="h-4 w-4" /> : undefined}
                trailing={item.badge}
                selected={item.selected}
                disabled={item.disabled}
                onClick={item.onSelect}
              />
            ))}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}

function PresentationContent({
  items,
  presentation,
  kind,
  ariaLabel,
  controlSize,
}: {
  items: AdaptiveControlItem[];
  presentation: AdaptiveControlPresentation;
  kind: "navigation" | "actions";
  ariaLabel: string;
  controlSize: ControlSize;
}) {
  if (presentation === "collapsed" && kind === "navigation") {
    const selected = items.find((item) => item.selected) ?? items[0];
    if (!selected) return null;
    return (
      <DropdownSelect
        label={selected.label}
        leading={selected.icon ? <selected.icon className="h-3.5 w-3.5" /> : undefined}
        value={selected.id}
        options={items.map((item) => ({
          value: item.id,
          label: item.badge == null ? item.label : `${item.label} (${String(item.badge)})`,
          leading: item.icon ? <item.icon className="h-3.5 w-3.5" /> : undefined,
          disabled: item.disabled,
        }))}
        onSelect={(id) => items.find((item) => item.id === id)?.onSelect?.()}
        ariaLabel={ariaLabel}
        controlSize={controlSize}
        className="min-w-32 bg-transparent hover:bg-zinc-800"
      />
    );
  }

  if (presentation === "collapsed") {
    const primary = items.filter((item) => item.priority === "primary");
    const overflow = items.filter((item) => item.priority !== "primary");
    return (
      <>
        {primary.map((item) => (
          <AdaptiveItemControl key={item.id} item={item} presentation="icon" kind={kind} controlSize={controlSize} />
        ))}
        {overflow.length > 0 && <OverflowControl items={overflow} controlSize={controlSize} />}
      </>
    );
  }

  return items.map((item) => (
    <AdaptiveItemControl
      key={item.id}
      item={item}
      presentation={presentation}
      kind={kind}
      controlSize={controlSize}
    />
  ));
}

export function AdaptiveControlGroup({
  items,
  kind,
  ariaLabel,
  controlSize = "compact",
  availableWidth,
  presentationOrder,
  className,
}: {
  items: AdaptiveControlItem[];
  kind: "navigation" | "actions";
  ariaLabel: string;
  controlSize?: ControlSize;
  /** A parent with independent chrome can pass its measured slot. */
  availableWidth?: number;
  presentationOrder?: AdaptiveControlPresentation[];
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRefs = useRef<Partial<Record<AdaptiveControlPresentation, HTMLDivElement | null>>>({});
  const order = useMemo<AdaptiveControlPresentation[]>(
    () => presentationOrder ?? (["iconText", "text", "icon", "collapsed"] satisfies AdaptiveControlPresentation[]),
    [presentationOrder],
  );
  const [presentation, setPresentation] = useState<AdaptiveControlPresentation>(() => order[0] ?? "collapsed");

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const slot = root.parentElement;
    const measure = () => {
      const width = availableWidth ?? slot?.getBoundingClientRect().width ?? root.getBoundingClientRect().width;
      const measured = Object.fromEntries(
        (["iconText", "text", "icon", "collapsed"] as const).map((candidate) => {
          const probe = probeRefs.current[candidate];
          return [candidate, probe ? Math.max(probe.scrollWidth, probe.getBoundingClientRect().width) : Number.POSITIVE_INFINITY];
        }),
      ) as unknown as AdaptiveControlWidths;
      setPresentation((current) => {
        const next = chooseAdaptiveControlPresentation(width, measured, order);
        return current === next ? current : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(slot ?? root);
    Object.values(probeRefs.current).forEach((probe) => probe && observer.observe(probe));
    return () => observer.disconnect();
  }, [availableWidth, items, kind, order]);

  return (
    <div
      ref={rootRef}
      role={kind === "navigation" ? "tablist" : "toolbar"}
      aria-label={ariaLabel}
      data-adaptive-control-group=""
      data-presentation={presentation}
      className={cn("relative flex min-w-0 items-center gap-1", className)}
    >
      <PresentationContent
        items={items}
        presentation={presentation}
        kind={kind}
        ariaLabel={ariaLabel}
        controlSize={controlSize}
      />
      <div data-adaptive-measurements="" className="pointer-events-none fixed -left-[10000px] top-0 invisible flex w-max items-center gap-1" aria-hidden="true">
        {/* design-system-exempt: menu-option — hidden intrinsic-width probes, not visible item rows. */}
        {(["iconText", "text", "icon", "collapsed"] as const).map((candidate) => (
          <div
            key={candidate}
            ref={(element) => { probeRefs.current[candidate] = element; }}
            data-adaptive-probe={candidate}
            className="flex w-max items-center gap-1"
          >
            <PresentationContent
              items={items}
              presentation={candidate}
              kind={kind}
              ariaLabel={`${ariaLabel} measurement`}
              controlSize={controlSize}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
