import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { ControlTrigger } from "./control-trigger";
import { MenuOption } from "./menu-option";
import { PopoverPanel, usePopoverDismiss } from "./popover";
import type { ControlSize } from "./control-size";

export interface DropdownSelectOption {
  value: string;
  label: ReactNode;
  leading?: ReactNode;
  disabled?: boolean;
  /** Opens a new group above this option: a hairline rule separating, for
   *  example, "pick one of these" from "make a new one". */
  separatorBefore?: boolean;
}

export function DropdownSelect({
  label,
  leading,
  content = "text",
  active = false,
  value,
  options,
  onSelect,
  ariaLabel,
  placement = "down",
  align = "start",
  controlSize,
  controlWidth = "fill",
  disabled,
  className,
  menuClassName,
}: {
  label: ReactNode;
  leading?: ReactNode;
  /** "icon" collapses the trigger to its leading glyph in a square ControlSize box.
   *  The label and chevron move out of the trigger: the value lives in `ariaLabel`
   *  (accessible name + tooltip) and in the menu, which still carries full text.
   *  For a picker whose options are names rather than glyphs, this is the only
   *  icon form available — N sessions cannot map to N distinguishable marks. */
  content?: "text" | "icon";
  /** Non-default selection, drawn as the shared neutral fill. An icon trigger has
   *  no visible label, so without this "All sessions" and "scoped to one bot" look
   *  identical; the fill is the shape backup the contract requires for a state a
   *  color alone would carry. */
  active?: boolean;
  value?: string | null;
  options: DropdownSelectOption[];
  onSelect: (value: string) => void;
  ariaLabel: string;
  placement?: "up" | "down";
  align?: "start" | "end";
  controlSize?: ControlSize;
  controlWidth?: "slot" | "fill";
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  usePopoverDismiss(open, () => setOpen(false), rootRef);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>("[role='option'][aria-selected='true']:not(:disabled)");
      const first = menuRef.current?.querySelector<HTMLButtonElement>("[role='option']:not(:disabled)");
      (selected ?? first)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']:not(:disabled)") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };

  const iconOnly = content === "icon";

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative inline-flex min-w-0",
        // A square trigger must keep its registered ControlSize box; without this the
        // flex row shrinks it into an unregistered in-between width.
        iconOnly ? "flex-shrink-0" : controlWidth === "fill" && "w-full",
      )}
    >
      <ControlTrigger
        ref={triggerRef}
        controlSize={controlSize}
        controlWidth={iconOnly ? "slot" : controlWidth}
        square={iconOnly}
        selected={open || active}
        disabled={disabled || options.length === 0}
        aria-label={ariaLabel}
        title={iconOnly ? ariaLabel : undefined}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
        className={cn(
          "text-content-primary",
          !(open || active) && "bg-zinc-900 hover:bg-zinc-800",
          iconOnly ? "justify-center" : "justify-start",
          className,
        )}
      >
        {leading && <span className="flex flex-shrink-0 items-center">{leading}</span>}
        {!iconOnly && (
          <>
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            <ChevronDown className={cn("h-4 w-4 flex-shrink-0 text-content-muted transition-transform", open && "rotate-180")} aria-hidden="true" />
          </>
        )}
      </ControlTrigger>
      {open && (
        <PopoverPanel placement={placement} align={align} className={cn("w-56 p-1", menuClassName)}>
          <div ref={menuRef} id={listboxId} role="listbox" tabIndex={-1} aria-label={ariaLabel} onKeyDown={onMenuKeyDown}>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Fragment key={option.value}>
                  {option.separatorBefore && (
                    <div role="separator" className="my-1 h-px bg-zinc-800" />
                  )}
                <MenuOption
                  role="option"
                  aria-selected={selected}
                  selected={selected}
                  disabled={option.disabled}
                  controlSize="regular"
                  label={option.label}
                  leading={option.leading}
                  trailing={selected ? <Check className="h-4 w-4" aria-hidden="true" /> : undefined}
                  onClick={() => {
                    onSelect(option.value);
                    close(true);
                  }}
                />
                </Fragment>
              );
            })}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
