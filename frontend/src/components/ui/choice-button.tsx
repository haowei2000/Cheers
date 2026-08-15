import {
  cloneElement,
  forwardRef,
  isValidElement,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button, type ButtonProps } from "./button";
import {
  controlIconClasses,
  useControlSize,
  type ControlSize,
} from "./control-size";
import { cn } from "@/lib/cn";

export interface ChoiceButtonProps
  extends Omit<
    ButtonProps,
    "action" | "children" | "content" | "controlWidth" | "loading" | "variant"
  > {
  label: string;
  leading: ReactNode;
  selected: boolean;
  description?: string;
}

/**
 * The visual half of a mutually exclusive choice. Use ChoiceGroup in product
 * code so radio semantics, roving focus, and arrow-key behavior stay together.
 */
export const ChoiceButton = forwardRef<HTMLButtonElement, ChoiceButtonProps>(
  (
    {
      label,
      leading,
      selected,
      description,
      controlSize,
      className,
      type = "button",
      ...props
    },
    ref,
  ) => {
    const size = useControlSize(controlSize);
    const sizedLeading = isValidElement(leading)
      ? cloneElement(leading as ReactElement<{ className?: string }>, {
          className: cn(
            (leading as ReactElement<{ className?: string }>).props.className,
            controlIconClasses[size],
          ),
        })
      : leading;

    return (
      <Button
        {...props}
        ref={ref}
        type={type}
        role="radio"
        aria-checked={selected}
        aria-label={description ? `${label}: ${description}` : label}
        title={description}
        data-selected={selected || undefined}
        content="iconText"
        controlWidth="fill"
        controlSize={size}
        variant="plain"
        className={cn(
          "text-content-muted",
          selected
            ? "bg-zinc-700 text-content-primary hover:bg-zinc-600"
            : "hover:bg-zinc-700/60 hover:text-content-secondary",
          className,
        )}
      >
        {sizedLeading}
        {label}
      </Button>
    );
  },
);
ChoiceButton.displayName = "ChoiceButton";

export interface ChoiceOption<Value extends string> {
  value: Value;
  label: string;
  leading: ReactNode;
  description?: string;
  disabled?: boolean;
}

export interface ChoiceGroupProps<Value extends string> {
  ariaLabel: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly ChoiceOption<Value>[];
  disabled?: boolean;
  controlSize?: ControlSize;
  className?: string;
  buttonClassName?: string;
}

/** A unified icon-and-text radio group for compact form choices. */
export function ChoiceGroup<Value extends string>({
  ariaLabel,
  value,
  onChange,
  options,
  disabled = false,
  controlSize,
  className,
  buttonClassName,
}: ChoiceGroupProps<Value>) {
  const buttons = useRef(new Map<Value, HTMLButtonElement>());
  const enabledOptions = options.filter((option) => !disabled && !option.disabled);
  const tabbableValue = enabledOptions.some((option) => option.value === value)
    ? value
    : enabledOptions[0]?.value;

  function moveFocus(currentValue: Value, direction: "first" | "last" | "next" | "previous") {
    if (enabledOptions.length === 0) return;
    const currentIndex = Math.max(
      0,
      enabledOptions.findIndex((option) => option.value === currentValue),
    );
    const nextIndex =
      direction === "first"
        ? 0
        : direction === "last"
          ? enabledOptions.length - 1
          : direction === "next"
            ? (currentIndex + 1) % enabledOptions.length
            : (currentIndex - 1 + enabledOptions.length) % enabledOptions.length;
    const nextValue = enabledOptions[nextIndex].value;
    onChange(nextValue);
    buttons.current.get(nextValue)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentValue: Value) {
    const direction =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? "next"
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? "previous"
          : event.key === "Home"
            ? "first"
            : event.key === "End"
              ? "last"
              : null;
    if (!direction) return;
    event.preventDefault();
    moveFocus(currentValue, direction);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn("grid grid-cols-2 gap-1 rounded-sm bg-zinc-800 p-1", className)}
    >
      {options.map((option) => {
        const optionDisabled = disabled || option.disabled;
        return (
          <ChoiceButton
            key={option.value}
            ref={(node) => {
              if (node) buttons.current.set(option.value, node);
              else buttons.current.delete(option.value);
            }}
            label={option.label}
            leading={option.leading}
            description={option.description}
            selected={value === option.value}
            disabled={optionDisabled}
            tabIndex={!optionDisabled && option.value === tabbableValue ? 0 : -1}
            controlSize={controlSize}
            className={buttonClassName}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => handleKeyDown(event, option.value)}
          />
        );
      })}
    </div>
  );
}
