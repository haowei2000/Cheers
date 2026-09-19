import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { controlMinHeightClasses, controlTextClasses, useControlSize, type ControlSize } from "./control-size";

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size" | "role"> {
  /** Visible label. A bare switch with no text is unreadable to everyone. */
  label: ReactNode;
  /** Spelled-out state beside the switch, so on/off never rests on colour and
   *  thumb position alone. Omit where the label already carries the state. */
  stateText?: ReactNode;
  controlSize?: ControlSize;
  labelPosition?: "start" | "end";
}

/**
 * A two-state switch that applies immediately. If the change only takes effect
 * on submit, that is a checkbox — the difference decides whether someone still
 * has to look for a Save button.
 *
 * The native input stays in the DOM and keeps every keyboard, label and form
 * behaviour; only its appearance is replaced. The thumb is styled from the
 * track with an explicit child selector, because `peer-checked:` reaches
 * siblings of the input, not their descendants.
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  (
    { label, stateText, controlSize, labelPosition = "end", className, id, disabled, ...props },
    ref
  ) => {
    const size = useControlSize(controlSize);
    const generatedId = useId();
    const inputId = id ?? generatedId;
    return (
      <label
        htmlFor={inputId}
        className={cn(
          "inline-flex items-center gap-3",
          controlMinHeightClasses[size],
          labelPosition === "start" && "flex-row-reverse justify-between",
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
          className
        )}
      >
        {/* design-system-native: checkbox — one shared primitive owns the only
            native switch input, so feature code never hand-rolls another. */}
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          role="switch"
          disabled={disabled}
          className="peer sr-only"
          {...props}
        />
        <span
          aria-hidden
          className={cn(
            "relative h-5 w-9 flex-shrink-0 rounded-sm bg-control ring-1 ring-inset ring-zinc-600",
            "transition-colors duration-100",
            "peer-checked:bg-content-strong peer-checked:ring-0",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-content-strong/50",
            "peer-checked:[&>span]:translate-x-4 peer-checked:[&>span]:bg-content-on-light"
          )}
        >
          <span className="absolute left-1 top-1 h-3.5 w-3.5 rounded-sm bg-content-secondary transition-transform duration-100" />
        </span>
        <span className={cn("flex min-w-0 flex-col", controlTextClasses[size])}>
          <span className="text-content-primary">{label}</span>
          {stateText !== undefined && <span className="text-compact text-content-muted">{stateText}</span>}
        </span>
      </label>
    );
  }
);
Switch.displayName = "Switch";
